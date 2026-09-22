import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { decodeControl, generateCode, relayEndpoints } from "@agenthop/tunnel";
import express from "express";
import { WebSocket } from "ws";
import { HostBridge } from "./bridge.js";
import { listenControl, Room } from "./room.js";
import { type SessionEvent } from "./talk.js";

export const DEFAULT_RELAY = "https://agenthop.imatrix.tech";

export type HostOptions = {
  relay?: string;
  pass?: string;
  code?: string;
  home?: string;
  onEvent?: (event: SessionEvent) => void;
};

export type RunningHost = {
  code: string;
  url: string;
  controlUrl: string;
  close: () => Promise<void>;
};

export function hostFile(home = path.join(homedir(), ".agenthop")): string {
  return path.join(home, "host.json");
}

export async function readHostFile(home = path.join(homedir(), ".agenthop")): Promise<{ controlUrl: string; code: string }> {
  const raw = await readFile(hostFile(home), "utf8");
  return JSON.parse(raw) as { controlUrl: string; code: string };
}

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const code = options.code ?? generateCode();
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const home = options.home ?? path.join(homedir(), ".agenthop");
  const { publicBase, hostUrl } = relayEndpoints(relay, code);
  const store = new InMemoryTaskStore();
  const room = new Room(store, path.join(home, "inbox"), options.onEvent);
  const control = await listenControl(room);
  const app = express();
  const localUrl = await listen(app);
  const card = agentCard(localUrl.url);
  const handler = new DefaultRequestHandler(card, store, room.executor());
  app.get("/agenthop/queue", (request, response) => {
    const after = Number(request.query.after ?? 0);
    response.json({ ...room.snapshot(), events: room.since(after) });
  });
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  const ws = new WebSocket(hostUrl, {
    headers: options.pass ? { authorization: `Bearer ${options.pass}` } : undefined,
  });
  const bridge = new HostBridge(localUrl.url, (frame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  });
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    bridge.onFrame(new Uint8Array(data as Buffer));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const ready = new Promise<string>((resolve, reject) => {
    ws.once("message", (data, isBinary) => {
      if (isBinary) {
        reject(new Error("expected ready"));
        return;
      }
      const controlMessage = decodeControl(data.toString());
      if (controlMessage.type === "error") reject(new Error(controlMessage.code));
      else if (controlMessage.type === "ready") resolve(controlMessage.publicBase);
      else reject(new Error("bad_control"));
    });
  });
  ws.send(JSON.stringify({ v: 1, type: "open", code }));
  const url = await ready;
  await mkdir(home, { recursive: true });
  await writeFile(hostFile(home), JSON.stringify({ code, controlUrl: control.url }));

  return {
    code,
    url,
    controlUrl: control.url,
    close: async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
        });
      }
      await control.close();
      await new Promise<void>((resolve, reject) => localUrl.server.close((error) => (error ? reject(error) : resolve())));
      await rm(hostFile(home), { force: true });
    },
  };
}

function agentCard(localUrl: string): AgentCard {
  return {
    name: "agenthop",
    description: "Shares one ordered queue. One message is in progress at a time.",
    version: "0.1.0",
    provider: undefined,
    supportedInterfaces: [
      {
        url: localUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: "",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/octet-stream"],
    defaultOutputModes: ["text/plain", "application/octet-stream"],
    skills: [
      {
        id: "answer",
        name: "Answer",
        description: "Speaks on the shared queue, one message at a time.",
        tags: ["agent"],
        examples: [],
        inputModes: ["text/plain", "application/octet-stream"],
        outputModes: ["text/plain", "application/octet-stream"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

async function listen(app: express.Express): Promise<{ url: string; server: Server }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return { url: `http://127.0.0.1:${address.port}`, server };
}
