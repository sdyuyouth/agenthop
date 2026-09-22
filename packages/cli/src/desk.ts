import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskState, type Artifact, type Task } from "@a2a-js/sdk";
import { ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import { filesFromPaths, partsFromMessage, safeName, type HopMessage, type Incoming } from "@agenthop/agent";

export type ListedFile = { name: string; mediaType: string; path: string };
export type ListedQuestion = { id: string; text: string; files: ListedFile[] };
export type HostEvent = { event: "received" | "sent"; id: string; text: string; files: ListedFile[] };

const callContext = new ServerCallContext();

/** Questions waiting for the local agent, and the task store the asker polls. */
export class Desk {
  readonly questions: ListedQuestion[] = [];

  constructor(
    private readonly store: TaskStore,
    private readonly inboxDir: string,
    private readonly onEvent?: (event: HostEvent) => void,
  ) {}

  async accept(incoming: Incoming): Promise<void> {
    const folder = path.join(this.inboxDir, incoming.id);
    await mkdir(folder, { recursive: true });
    const files: ListedFile[] = [];
    for (const file of incoming.message.files) {
      const name = safeName(file.name);
      const filePath = path.join(folder, name);
      await writeFile(filePath, file.bytes);
      files.push({ name, mediaType: file.mediaType, path: filePath });
    }
    const question = { id: incoming.id, text: incoming.message.text, files };
    this.questions.push(question);
    this.onEvent?.({ event: "received", ...question });
  }

  async reply(id: string, message: HopMessage, files: ListedFile[] = []): Promise<void> {
    const task = await this.store.load(id, callContext);
    if (!task) throw new Error(`unknown question ${id}`);
    const parts = partsFromMessage(message);
    const artifact: Artifact = {
      artifactId: `${id}-result`,
      name: "Result",
      description: "",
      parts,
      metadata: {},
      extensions: [],
    };
    const next: Task = {
      ...task,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [artifact],
    };
    await this.store.save(next, callContext);
    const index = this.questions.findIndex((item) => item.id === id);
    if (index >= 0) this.questions.splice(index, 1);
    this.onEvent?.({ event: "sent", id, text: message.text, files });
  }
}

export async function listenControl(desk: Desk): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/inbox") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(desk.questions));
        return;
      }
      if (request.method === "POST" && request.url === "/reply") {
        const body = JSON.parse(await readBody(request)) as { id?: string; text?: string; files?: string[] };
        if (!body.id) throw new Error("id is required");
        const paths = body.files ?? [];
        const loaded = await filesFromPaths(paths);
        const files = loaded.map((file, index) => ({
          name: file.name,
          mediaType: file.mediaType,
          path: path.resolve(paths[index] ?? file.name),
        }));
        await desk.reply(body.id, { text: body.text ?? "", files: loaded }, files);
        response.writeHead(204);
        response.end();
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
