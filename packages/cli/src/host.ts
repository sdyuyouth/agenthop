import { createServer, type Server } from "node:http";
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
  /** The relay dropped the room: the socket closed, or it was never able to stay open. */
  onGone?: (reason: string) => void;
};

export type RunningHost = {
  code: string;
  url: string;
  controlUrl: string;
  close: () => Promise<void>;
};

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const code = options.code ?? generateCode();
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const home = options.home ?? path.join(homedir(), ".agenthop");
  const { publicBase, hostUrl } = relayEndpoints(relay, code);
  const room = new Room(path.join(home, "inbox"), options.onEvent);
  const control = await listenControl(room);
  const app = express();
  const localUrl = await listen(app);
  const card = agentCard(localUrl.url);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), room.executor());
  app.get("/agenthop/queue", (request, response) => {
    response.json({ events: room.since(Number(request.query.after ?? 0)) });
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
    ws.once("error", (error) => reject(relayError(error, relay)));
  });
  const ready = new Promise<string>((resolve, reject) => {
    ws.once("message", (data, isBinary) => {
      if (isBinary) {
        reject(new Error("expected ready"));
        return;
      }
      const controlMessage = decodeControl(data.toString());
      if (controlMessage.type === "error") reject(new Error(openError(controlMessage.code)));
      else if (controlMessage.type === "ready") resolve(controlMessage.publicBase);
      else reject(new Error("bad_control"));
    });
  });
  ws.send(JSON.stringify({ v: 1, type: "open", code }));
  const url = await ready;

  let closing = false;
  ws.on("close", () => {
    if (!closing) options.onGone?.("中继连接断开，房间已经不在了");
  });

  return {
    code,
    url,
    controlUrl: control.url,
    close: async () => {
      closing = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
        });
      }
      await control.close();
      await new Promise<void>((resolve, reject) => localUrl.server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function relayError(error: unknown, relay: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`连不上中继 ${relay}：${detail}`);
}

function openError(code: string): string {
  if (code === "room_taken") return "这个配对码已经有人在用了，换一个新的房间";
  if (code === "unauthorized") return "中继需要密码，两边都要加 --pass";
  if (code === "rate_limited") return "开房太频繁，等一分钟再试";
  return code;
}

function agentCard(localUrl: string): AgentCard {
  return {
    name: "agenthop",
    description: "Carries one conversation between two agents, in order.",
    version: "0.2.0",
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
        id: "say",
        name: "Say",
        description: "Adds one line to the shared conversation.",
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
