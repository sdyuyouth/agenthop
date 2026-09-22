import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskState, type Artifact, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { filesFromPaths, messageFromParts, partsFromMessage, safeName, type HopMessage } from "@agenthop/agent";
import { Talk, type SessionEvent, type SessionFile, type Side } from "./talk.js";

const callContext = new ServerCallContext();

export type Ack = {
  id: string;
  kind: SessionEvent["kind"];
  event: SessionEvent["event"];
  from: Side;
  text: string;
  current: string | null;
  pending: string[];
  wait: boolean;
};

type IncomingKind = "say" | "ask" | "supplement" | "result";

/** The room's queue, the files it stores, and the A2A tasks the peer polls. */
export class Room {
  private readonly talk = new Talk();
  private tail: Promise<void> = Promise.resolve();
  private watermark = 0;

  constructor(
    private readonly store: TaskStore,
    private readonly inboxDir: string,
    private readonly onEvent?: (event: SessionEvent) => void,
  ) {}

  executor(): AgentExecutor {
    return {
      cancelTask: async () => undefined,
      execute: (context, bus) => this.execute(context, bus),
    };
  }

  snapshot(): { current: string | null; pending: string[] } {
    return this.talk.snapshot();
  }

  since(seq: number): SessionEvent[] {
    return this.talk.since(seq);
  }

  async local(input: { text: string; files: string[]; kind: IncomingKind; answerId?: string; id: string }): Promise<Ack> {
    const loaded = await filesFromPaths(input.files);
    const listed = loaded.map((file, index) => ({
      name: file.name,
      mediaType: file.mediaType,
      path: path.resolve(input.files[index] ?? file.name),
    }));
    return this.admit({
      id: input.kind === "result" ? (input.answerId ?? "") : input.id,
      messageId: input.id,
      from: "host",
      kind: input.kind,
      answerId: input.answerId,
      message: { text: input.text, files: loaded },
      files: listed,
    });
  }

  status(id: string): { id: string; state: string; result: { text: string; files: SessionFile[] } | null } & ReturnType<Talk["snapshot"]> {
    const found = this.talk.item(id);
    if (!found) throw new Error(`unknown message ${id}`);
    return { id, state: found.state, result: found.result ?? null, ...this.talk.snapshot() };
  }

  private async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const message = messageFromParts(context.userMessage.parts);
    const meta = context.userMessage.metadata ?? {};
    const kind = kindOf(meta.kind);
    const answerId = typeof meta.answerId === "string" ? meta.answerId : undefined;
    const files = await this.storeFiles(context.taskId, message);
    const ack = await this.admit({
      id: kind === "result" ? (answerId ?? "") : context.taskId,
      messageId: context.taskId,
      from: "peer",
      kind,
      answerId,
      message,
      files,
    });
    if (ack.wait) {
      bus.publish(AgentEvent.task(openTask(context, TaskState.TASK_STATE_WORKING, [])));
      return;
    }
    bus.publish(
      AgentEvent.task(openTask(context, TaskState.TASK_STATE_COMPLETED, partsFromMessage({ text: JSON.stringify(ack), files: [] }))),
    );
  }

  private async admit(input: {
    id: string;
    messageId: string;
    from: Side;
    kind: IncomingKind;
    answerId?: string;
    message: HopMessage;
    files: SessionFile[];
  }): Promise<Ack> {
    const outcome = await this.run(async () => {
      if (input.kind === "result") {
        if (!input.answerId) throw new Error("answer id is required");
        const done = this.talk.answer(input.answerId, { from: input.from, text: input.message.text, files: input.files });
        await this.completeAsk(input.answerId, input.message);
        return { ack: ackOf(done, false), events: this.takeNew() };
      }
      if (input.kind === "supplement") {
        const event = this.talk.supplement({
          id: input.messageId,
          from: input.from,
          text: input.message.text,
          files: input.files,
        });
        return { ack: ackOf(event, false), events: this.takeNew() };
      }
      const event = this.talk.push({
        id: input.id,
        kind: input.kind,
        from: input.from,
        text: input.message.text,
        files: input.files,
      });
      return { ack: ackOf(event, input.kind === "ask"), events: this.takeNew() };
    });
    for (const event of outcome.events) await this.onEvent?.(event);
    return outcome.ack;
  }

  private takeNew(): SessionEvent[] {
    const events = this.talk.since(this.watermark);
    const last = events[events.length - 1];
    if (last) this.watermark = last.seq;
    return events;
  }

  private async completeAsk(id: string, message: HopMessage): Promise<void> {
    const task = await this.store.load(id, callContext);
    if (!task) return;
    const artifact: Artifact = {
      artifactId: `${id}-result`,
      name: "Result",
      description: "",
      parts: partsFromMessage(message),
      metadata: {},
      extensions: [],
    };
    const next: Task = {
      ...task,
      status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [artifact],
    };
    await this.store.save(next, callContext);
  }

  private async storeFiles(id: string, message: HopMessage): Promise<SessionFile[]> {
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
        sendJson(response, { ...room.snapshot(), events: room.since(Number(url.searchParams.get("after") ?? 0)) });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/message/")) {
        sendJson(response, room.status(decodeURIComponent(url.pathname.slice("/message/".length))));
        return;
      }
      if (request.method === "POST" && url.pathname === "/message") {
        const body = JSON.parse(await readBody(request)) as {
          id?: string;
          text?: string;
          files?: string[];
          kind?: IncomingKind;
          answerId?: string;
        };
        if (!body.id) throw new Error("id is required");
        const ack = await room.local({
          id: body.id,
          text: body.text ?? "",
          files: body.files ?? [],
          kind: body.kind ?? "say",
          answerId: body.answerId,
        });
        sendJson(response, ack);
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

function ackOf(event: SessionEvent, wait: boolean): Ack {
  return {
    id: event.id,
    kind: event.kind,
    event: event.event,
    from: event.from,
    text: event.text,
    current: event.current,
    pending: event.pending,
    wait,
  };
}

function kindOf(value: unknown): IncomingKind {
  if (value === "ask" || value === "supplement" || value === "result") return value;
  return "say";
}

function openTask(context: RequestContext, state: TaskState, parts: Task["artifacts"][number]["parts"]): Task {
  return {
    id: context.taskId,
    contextId: context.contextId,
    status: { state, timestamp: new Date().toISOString(), message: undefined },
    artifacts:
      parts.length === 0
        ? []
        : [{ artifactId: `${context.taskId}-ack`, name: "Ack", description: "", parts, metadata: {}, extensions: [] }],
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
