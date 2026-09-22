import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { filesFromPaths, messageFromParts, partsFromMessage, safeName, type HopFile, type HopMessage } from "@agenthop/agent";
import { normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { DEFAULT_RELAY } from "./host.js";

export type SendOptions = {
  code: string;
  text: string;
  files?: string[];
  relay?: string;
  pass?: string;
  outDir?: string;
  waitMs?: number;
};

export type SendResult = {
  text: string;
  files: { name: string; mediaType: string; path: string }[];
};

export async function sendMessage(options: SendOptions): Promise<SendResult> {
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const { publicBase } = relayEndpoints(relay, normalizeCode(options.code));
  const message: HopMessage = { text: options.text, files: await filesFromPaths(options.files ?? []) };
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
    const request = {
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
        parts: partsFromMessage(message),
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
    };
    const created = asTask(await client.sendMessage(request));
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
    return { text: result.text, files: await writeFiles(options.outDir ?? "agenthop-out", task.id, result.files) };
  } finally {
    globalThis.fetch = previous;
  }
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
