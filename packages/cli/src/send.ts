import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { filesFromPaths, messageFromParts, partsFromMessage, safeName, type HopFile } from "@agenthop/agent";
import { normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { DEFAULT_RELAY, readHostFile } from "./host.js";
import { autoReply } from "./receive.js";
import { type Ack } from "./room.js";
import { type SessionEvent } from "./talk.js";

export type SendKind = "say" | "ask" | "supplement" | "result";

export type SendOptions = {
  code?: string;
  text: string;
  files?: string[];
  relay?: string;
  pass?: string;
  outDir?: string;
  waitMs?: number;
  kind?: SendKind;
  answerId?: string;
};

export type SendResult = {
  id: string;
  kind: string;
  event: string;
  from?: string;
  text: string;
  files: { name: string; mediaType: string; path: string }[];
  current: string | null;
  pending: string[];
};

export async function sendMessage(options: SendOptions): Promise<SendResult> {
  const kind = options.kind ?? "say";
  if (!options.code) return sendLocal(options, kind);
  return sendRemote(options, kind);
}

export async function followRoom(options: {
  code: string;
  relay?: string;
  pass?: string;
  onReceive?: string;
  signal?: AbortSignal;
  onReady?: () => void;
  onEvent: (event: SessionEvent) => void;
}): Promise<void> {
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const code = normalizeCode(options.code);
  const { publicBase } = relayEndpoints(relay, code);
  let after = 0;
  let synced = false;
  let replies = Promise.resolve();
  const sent = new Set<string>();
  const handled = new Set<string>();
  for (;;) {
    if (options.signal?.aborted) return;
    const body = await readQueue(publicBase, after, options.pass);
    const fresh: SessionEvent[] = [];
    for (const event of body.events) {
      options.onEvent(event);
      after = event.seq;
      fresh.push(event);
    }
    if (!synced) {
      synced = true;
      options.onReady?.();
    } else if (options.onReceive) {
      for (const event of fresh) scheduleReceive(options.onReceive, event);
    }
    await delay(300);
  }

  function scheduleReceive(command: string, event: SessionEvent): void {
    if (event.event === "queued" || sent.has(event.id) || handled.has(event.id)) return;
    handled.add(event.id);
    replies = replies.then(() =>
      autoReply(command, event, async (text) => {
        const result = await sendMessage({
          code,
          text,
          relay,
          pass: options.pass,
          kind: event.event === "current" ? "result" : "say",
          answerId: event.event === "current" ? event.id : undefined,
        });
        sent.add(result.id);
      }),
    );
  }
}

export async function readQueue(publicBase: string, after = 0, pass?: string): Promise<{
  current: string | null;
  pending: string[];
  events: SessionEvent[];
}> {
  const response = await fetch(`${publicBase}agenthop/queue?after=${after}`, {
    headers: pass ? { authorization: `Bearer ${pass}` } : {},
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as { current: string | null; pending: string[]; events: SessionEvent[] };
}

async function sendLocal(options: SendOptions, kind: SendKind): Promise<SendResult> {
  const host = await readHostFile();
  const id = randomUUID();
  const response = await fetch(`${host.controlUrl}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, text: options.text, files: options.files ?? [], kind, answerId: options.answerId }),
  });
  if (!response.ok) throw new Error(await response.text());
  const ack = (await response.json()) as Ack;
  if (!ack.wait) return { ...ack, files: [] };
  return waitLocal(host.controlUrl, ack.id, options.waitMs ?? 9 * 60 * 1000);
}

async function waitLocal(controlUrl: string, id: string, waitMs: number): Promise<SendResult> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${controlUrl}/message/${id}`);
    if (!response.ok) throw new Error(await response.text());
    const body = (await response.json()) as {
      state: string;
      result: { text: string; files: SendResult["files"] } | null;
      current: string | null;
      pending: string[];
    };
    if (body.state === "done" && body.result) {
      return {
        id,
        kind: "result",
        event: "done",
        text: body.result.text,
        files: body.result.files,
        current: body.current,
        pending: body.pending,
      };
    }
    await delay(300);
  }
  throw new Error(`no result for ${id}`);
}

async function sendRemote(options: SendOptions, kind: SendKind): Promise<SendResult> {
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const code = normalizeCode(options.code ?? "");
  const { publicBase } = relayEndpoints(relay, code);
  const previous = globalThis.fetch;
  if (options.pass) {
    const pass = options.pass;
    globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${pass}`);
      return previous(input, { ...init, headers });
    };
  }
  try {
    const client = await new ClientFactory().createFromUrl(publicBase);
    const created = asTask(
      await client.sendMessage({
        tenant: "",
        configuration: {
          returnImmediately: true,
          acceptedOutputModes: ["text/plain", "application/octet-stream"],
          taskPushNotificationConfig: undefined,
        },
        metadata: undefined,
        message: {
          messageId: randomUUID(),
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: partsFromMessage({ text: options.text, files: await filesFromPaths(options.files ?? []) }),
          extensions: [],
          metadata: { kind, answerId: options.answerId ?? "" },
          referenceTaskIds: [],
        },
      }),
    );
    if (kind !== "ask") return JSON.parse(textOf(created)) as SendResult;
    const deadline = Date.now() + (options.waitMs ?? 9 * 60 * 1000);
    let task = created;
    while (Date.now() < deadline) {
      const state = task.status?.state;
      if (isSuccess(state)) break;
      if (isFailure(state)) throw new Error(`question ${task.id} failed`);
      await delay(300);
      task = asTask(await client.getTask({ tenant: "", id: task.id }));
    }
    if (!isSuccess(task.status?.state)) throw new Error(`no result for ${task.id}`);
    const result = messageFromParts(task.artifacts?.flatMap((artifact) => artifact.parts ?? []) ?? []);
    const snap = await readQueue(publicBase, 0, options.pass);
    return {
      id: task.id,
      kind: "result",
      event: "done",
      text: result.text,
      files: await writeFiles(options.outDir ?? "agenthop-out", task.id, result.files),
      current: snap.current,
      pending: snap.pending,
    };
  } finally {
    globalThis.fetch = previous;
  }
}

function textOf(task: Task): string {
  return messageFromParts(task.artifacts?.flatMap((artifact) => artifact.parts ?? []) ?? []).text;
}

function asTask(value: unknown): Task {
  if (value && typeof value === "object" && "status" in value && "id" in value) return value as Task;
  const wrapped = value as { task?: Task };
  if (wrapped.task) return wrapped.task;
  throw new Error("relay did not return a task");
}

function isSuccess(state: TaskState | string | number | undefined): boolean {
  return state === TaskState.TASK_STATE_COMPLETED || state === "TASK_STATE_COMPLETED";
}

function isFailure(state: TaskState | string | number | undefined): boolean {
  return (
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED ||
    state === "TASK_STATE_FAILED" ||
    state === "TASK_STATE_CANCELED" ||
    state === "TASK_STATE_REJECTED"
  );
}

async function writeFiles(outDir: string, id: string, files: HopFile[]): Promise<SendResult["files"]> {
  const saved: SendResult["files"] = [];
  if (files.length === 0) return saved;
  const folder = path.join(outDir, id);
  await mkdir(folder, { recursive: true });
  for (const file of files) {
    const filePath = path.join(folder, safeName(file.name));
    await writeFile(filePath, file.bytes);
    saved.push({ name: file.name, mediaType: file.mediaType, path: filePath });
  }
  return saved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
