import { randomUUID } from "node:crypto";
import { Role, type Task } from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import { filesFromPaths, messageFromParts, partsFromMessage, type HopFile } from "@agenthop/agent";
import { normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { DEFAULT_RELAY } from "./host.js";
import { type SessionEvent } from "./talk.js";

export type SendOptions = {
  code: string;
  text: string;
  files?: string[];
  /** Files already in hand — sealed ones, which never exist on disk as themselves. */
  attachments?: HopFile[];
  relay?: string;
  pass?: string;
};

/**
 * The relay is carrying as much for this room as it will this minute. Nothing is lost and the
 * right thing to do is known — wait and send again — so it is told apart from a real failure.
 * `room_quota` is also a 429, but that one is permanent and must not be retried.
 */
export class Throttled extends Error {}

/**
 * One client per room. Making one fetches the room's Agent Card through the relay and the tunnel
 * — a whole extra round trip — and doing that for every line halved how fast a conversation
 * could go over a relay far away. The client picks up `fetch` when it sends, so the password
 * header still applies.
 */
const clients = new Map<string, Promise<Client>>();

function clientFor(publicBase: string): Promise<Client> {
  let client = clients.get(publicBase);
  if (!client) {
    client = new ClientFactory().createFromUrl(publicBase);
    clients.set(publicBase, client);
    client.catch(() => clients.delete(publicBase));
  }
  return client;
}

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
    const client = await clientFor(publicBase);
    const task = asTask(
      await throttledAs(client.sendMessage({
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
          parts: partsFromMessage({ text: options.text, files: [...(await filesFromPaths(options.files ?? [])), ...(options.attachments ?? [])] }),
          extensions: [],
          metadata: undefined,
          referenceTaskIds: [],
        },
      })),
    );
    // A refusal comes back as an ordinary 200 with the reason in the body. Returning it as
    // though it were an accepted line is how a caller ends up writing `local say` for something
    // that never entered the conversation.
    const ack = JSON.parse(textOf(task)) as SessionEvent | { refused: string };
    if ("refused" in ack) throw new Error(ack.refused);
    return ack;
  } catch (error) {
    // The room may have gone and come back; the next line starts from its Agent Card again.
    if (!(error instanceof Throttled)) clients.delete(publicBase);
    throw error;
  } finally {
    globalThis.fetch = previous;
  }
}

async function throttledAs<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof Error && /\brate_limited\b/.test(error.message)) throw new Throttled(error.message);
    throw error;
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
