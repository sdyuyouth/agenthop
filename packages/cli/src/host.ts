import { createServer, type Server } from "node:http";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import { HopExecutor } from "@agenthop/agent";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { decodeControl, generateCode, relayEndpoints } from "@agenthop/tunnel";
import express from "express";
import { WebSocket } from "ws";
import { HostBridge } from "./bridge.js";

export const DEFAULT_RELAY = "https://agenthop-relay.2629133574.workers.dev";

export type HostOptions = {
  dir?: string;
  relay?: string;
  pass?: string;
  code?: string;
};

export type RunningHost = {
  code: string;
  url: string;
  close: () => Promise<void>;
};

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const code = options.code ?? generateCode();
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const { publicBase, hostUrl } = relayEndpoints(relay, code);
  const app = express();
  const localUrl = await listen(app);
  const card = agentCard(localUrl.url, options.dir);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new HopExecutor(options.dir));
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
      const control = decodeControl(data.toString());
      if (control.type === "error") reject(new Error(control.code));
      else if (control.type === "ready") resolve(control.publicBase);
      else reject(new Error("bad_control"));
    });
  });
  ws.send(JSON.stringify({ v: 1, type: "open", code }));
  const url = await ready;

  return {
    code,
    url,
    close: async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
        });
      }
      await new Promise<void>((resolve, reject) => localUrl.server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function agentCard(localUrl: string, dir?: string): AgentCard {
  const skill = (id: string, name: string, description: string, tags: string[]) => ({
    id,
    name,
    description,
    tags,
    examples: [] as string[],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    securityRequirements: [],
  });
  return {
    name: "agenthop",
    description: dir ? "Reads text files shared for this pairing." : "Echoes a message.",
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
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      skill("echo", "Echo", "Repeats the message when no file is named.", ["echo"]),
      ...(dir
        ? [skill("read_text", "Read text", "Reads a UTF-8 file named in the message from the host directory.", ["files"])]
        : []),
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
