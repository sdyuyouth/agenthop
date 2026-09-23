import { randomUUID } from "node:crypto";
import { Role, type Task } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { filesFromPaths, messageFromParts, partsFromMessage } from "@agenthop/agent";
import { normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { DEFAULT_RELAY } from "./host.js";
import { type SessionEvent } from "./talk.js";

export type SendOptions = {
  code: string;
  text: string;
  files?: string[];
  relay?: string;
  pass?: string;
};

/** Post one line into the room over the relay. Resolves once the host has it in order. */
export async function sendMessage(options: SendOptions): Promise<SessionEvent> {
  const publicBase = roomBase(options.relay, options.code);
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
    const task = asTask(
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
          metadata: undefined,
          referenceTaskIds: [],
        },
      }),
    );
    return JSON.parse(textOf(task)) as SessionEvent;
  } finally {
    globalThis.fetch = previous;
  }
}

export async function readQueue(publicBase: string, after = 0, pass?: string): Promise<{ events: SessionEvent[] }> {
  const response = await fetch(`${publicBase}agenthop/queue?after=${after}`, {
    headers: pass ? { authorization: `Bearer ${pass}` } : {},
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as { events: SessionEvent[] };
}

export function roomBase(relay: string | undefined, code: string): string {
  return relayEndpoints(relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY, normalizeCode(code)).publicBase;
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
