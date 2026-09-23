import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskState, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { filesFromPaths, messageFromParts, partsFromMessage, safeName, type HopMessage } from "@agenthop/agent";
import { Talk, type SessionEvent, type SessionFile, type Side } from "./talk.js";

/** What one conversation may spend. Anyone holding the code can post, so the room counts. */
export type RoomLimits = { bytes: number; messages: number; textBytes: number };

export const DEFAULT_LIMITS: RoomLimits = {
  bytes: 8 * 1024 * 1024,
  messages: 2000,
  textBytes: 64 * 1024,
};

export type RoomOptions = {
  inboxDir: string;
  onEvent?: (event: SessionEvent) => void;
  /** Decides whether an incoming line belongs to this conversation, before anything is kept. */
  accept?: (text: string) => boolean;
  /** Why something was turned away. The session writes it down. */
  onRefused?: (reason: string, text: string) => void;
  /** Write incoming attachments to the inbox. Off unless the person asked for it. */
  keepFiles?: boolean;
  limits?: Partial<RoomLimits>;
};

/** The room's ordered log, the files it stores, and the A2A endpoint the joining side posts to. */
export class Room {
  private readonly talk = new Talk();
  private tail: Promise<void> = Promise.resolve();
  private watermark = 0;
  private readonly inboxDir: string;
  private readonly onEvent?: (event: SessionEvent) => void;
  private readonly limits: RoomLimits;
  private spent = { bytes: 0, messages: 0 };

  constructor(private readonly options: RoomOptions) {
    this.inboxDir = options.inboxDir;
    this.onEvent = options.onEvent;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  executor(): AgentExecutor {
    return {
      cancelTask: async () => undefined,
      execute: (context, bus) => this.execute(context, bus),
    };
  }

  since(seq: number): SessionEvent[] {
    return this.talk.since(seq);
  }

  async local(input: { id: string; text: string; files?: string[] }): Promise<SessionEvent> {
    const paths = input.files ?? [];
    const loaded = await filesFromPaths(paths);
    const listed = loaded.map((file, index) => ({
      name: file.name,
      mediaType: file.mediaType,
      path: path.resolve(paths[index] ?? file.name),
    }));
    return this.admit({ id: input.id, from: "host", message: { text: input.text, files: loaded }, files: listed });
  }

  private async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const message = messageFromParts(context.userMessage.parts);
    const refusal = this.refuse(message);
    if (refusal) {
      // Nothing is stored and nothing reaches the conversation: turning it away has to mean that.
      this.options.onRefused?.(refusal, message.text);
      bus.publish(AgentEvent.task(openTask(context, partsFromMessage({ text: JSON.stringify({ refused: refusal }), files: [] }))));
      return;
    }
    const files = this.options.keepFiles ? await this.storeFiles(context.taskId, message) : listOnly(message);
    const event = await this.admit({ id: context.taskId, from: "peer", message, files });
    bus.publish(AgentEvent.task(openTask(context, partsFromMessage({ text: JSON.stringify(event), files: [] }))));
  }

  /** Reasons an incoming line is not part of this conversation, checked before anything is kept. */
  private refuse(message: HopMessage): string | undefined {
    if (this.options.accept && !this.options.accept(message.text)) {
      return "另一个人拿着同一个配对码说话，已经忽略";
    }
    const size = Buffer.byteLength(message.text) + message.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (Buffer.byteLength(message.text) > this.limits.textBytes) {
      return `一条消息的正文超过 ${Math.round(this.limits.textBytes / 1024)} KiB，已经拒绝`;
    }
    if (this.spent.messages + 1 > this.limits.messages) {
      return `这次会话的消息条数已经到上限 ${this.limits.messages}，后面的都拒绝`;
    }
    if (this.spent.bytes + size > this.limits.bytes) {
      return `这次会话的总量已经到上限 ${Math.round(this.limits.bytes / 1024 / 1024)} MiB，后面的都拒绝`;
    }
    this.spent.messages += 1;
    this.spent.bytes += size;
    return undefined;
  }

  /** Events are handed to `onEvent` after the lock is released, so a listener may speak without re-entering it. */
  private async admit(input: { id: string; from: Side; message: HopMessage; files: SessionFile[] }): Promise<SessionEvent> {
    const outcome = await this.run(async () => {
      const event = this.talk.push({ id: input.id, from: input.from, text: input.message.text, files: input.files });
      return { event, events: this.takeNew() };
    });
    for (const event of outcome.events) this.onEvent?.(event);
    return outcome.event;
  }

  private takeNew(): SessionEvent[] {
    const events = this.talk.since(this.watermark);
    const last = events[events.length - 1];
    if (last) this.watermark = last.seq;
    return events;
  }

  private async storeFiles(id: string, message: HopMessage): Promise<SessionFile[]> {
    if (message.files.length === 0) return [];
    const folder = path.join(this.inboxDir, id);
    await mkdir(folder, { recursive: true });
    const files: SessionFile[] = [];
    for (const file of message.files) {
      const name = safeName(file.name);
      const filePath = path.join(folder, name);
      await writeFile(filePath, file.bytes);
      files.push({ name, mediaType: file.mediaType, path: filePath });
    }
    return files;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export async function listenControl(room: Room): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/queue") {
        sendJson(response, { events: room.since(Number(url.searchParams.get("after") ?? 0)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/message") {
        const body = JSON.parse(await readBody(request)) as { id?: string; text?: string; files?: string[] };
        if (!body.id) throw new Error("id is required");
        sendJson(response, await room.local({ id: body.id, text: body.text ?? "", files: body.files }));
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "failed");
    }
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** The names came in, the bytes did not. */
function listOnly(message: HopMessage): SessionFile[] {
  return message.files.map((file) => ({ name: safeName(file.name), mediaType: file.mediaType, path: "" }));
}

function openTask(context: RequestContext, parts: Task["artifacts"][number]["parts"]): Task {
  return {
    id: context.taskId,
    contextId: context.contextId,
    status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [{ artifactId: `${context.taskId}-ack`, name: "Ack", description: "", parts, metadata: {}, extensions: [] }],
    history: [context.userMessage],
    metadata: {},
  };
}

function sendJson(response: import("node:http").ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
