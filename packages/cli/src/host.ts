import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { addressOf, decodeControl, generateCode, relayEndpoints } from "@agenthop/tunnel";
import express from "express";
import { WebSocket } from "ws";
import { HostBridge } from "./bridge.js";
import { listenControl, Room, type RoomLimits, type RoomOptions } from "./room.js";
import { type SessionEvent } from "./talk.js";
import { version } from "./version.js";

export const DEFAULT_RELAY = "https://agenthop.imatrix.tech";

/** How long a dropped room keeps being reopened before the conversation is called off. */
export const RECOVER_MS = 45_000;
/** A relay that accepts the socket but never answers must not hang the command forever. */
export const HANDSHAKE_MS = 15_000;

export type HostOptions = {
  relay?: string;
  pass?: string;
  code?: string;
  home?: string;
  onEvent?: (event: SessionEvent) => void;
  /** Decides whether an incoming line belongs to this conversation, before anything is kept. */
  accept?: (text: string) => boolean | string;
  onRefused?: (reason: string, text: string) => void;
  unsealFiles?: RoomOptions["unsealFiles"];
  /** Write incoming attachments to the inbox. Off unless the person asked for it. */
  keepFiles?: boolean;
  limits?: Partial<RoomLimits>;
  /** The socket dropped and the room is being reopened with the same code. */
  onReconnecting?: (reason: string) => void;
  onReconnected?: () => void;
  /** Reopening failed for long enough to give up. */
  onGone?: (reason: string) => void;
  /** How long to keep reopening the room before giving up. */
  recoverMs?: number;
  /**
   * The token that holds the room at the relay. Random unless given: a room that must be taken
   * straight back after a restart — the inbox — derives it from something only it has.
   */
  token?: string;
  /**
   * Whether anyone with the address may read the room's record over the relay. A conversation
   * needs it (the joining side reads it); an inbox does not, and has no reason to offer it.
   */
  serveQueue?: boolean;
};

export type RunningHost = {
  code: string;
  url: string;
  controlUrl: string;
  close: () => Promise<void>;
};

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  // Only the address half ever gets this far. Everything downstream — the relay URLs, the open
  // frame, RunningHost.code — is then address-only by construction rather than by care.
  const code = addressOf(options.code ?? generateCode());
  // One token for the life of the room. Reopening the room after a blip shows the same one, so
  // the relay can tell the host coming back from someone else who picked up the code.
  const token = options.token ?? randomBytes(32).toString("base64url");
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const home = options.home ?? path.join(homedir(), ".agenthop");
  const { publicBase, hostUrl } = relayEndpoints(relay, code);
  const room = new Room({
    inboxDir: path.join(home, "inbox"),
    onEvent: options.onEvent,
    accept: options.accept,
    onRefused: options.onRefused,
    unsealFiles: options.unsealFiles,
    keepFiles: options.keepFiles,
    limits: options.limits,
  });
  const control = await listenControl(room);
  const app = express();
  // The SDK's own parser would cap a body at 100 KiB, well under the attachment limit.
  app.use(express.json({ limit: "2mb" }));
  const localUrl = await listen(app);
  const card = agentCard(localUrl.url);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), room.executor());
  app.get("/agenthop/queue", (request, response) => {
    if (options.serveQueue === false) {
      response.status(404).end();
      return;
    }
    response.json({ events: room.since(Number(request.query.after ?? 0)).map(overTheRelay) });
  });
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  let socket: WebSocket | undefined;
  let closing = false;
  const bridge = new HostBridge(localUrl.url, (frame) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
  });

  /** Open the room. The code stays the same, so reopening it puts the conversation back. */
  function openRoom(): Promise<{ ws: WebSocket; url: string }> {
    // One deadline over the whole thing: a relay that takes the connection and then goes quiet,
    // at any step, must not leave the command sitting there with nothing on screen.
    return withDeadline(connectRoom(), HANDSHAKE_MS, `中继 ${relay} 没有把房间开起来，${HANDSHAKE_MS / 1000} 秒后放弃`);
  }

  async function connectRoom(): Promise<{ ws: WebSocket; url: string }> {
    const ws = new WebSocket(hostUrl, {
      headers: options.pass ? { authorization: `Bearer ${options.pass}` } : undefined,
    });
    // A refusal can arrive the moment the relay accepts the socket, before we have sent
    // anything. Listen first: waiting for the open event before attaching means missing it and
    // then waiting out the deadline for a `ready` that was never coming.
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
    ready.catch(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (error) => reject(relayError(error, relay)));
      });
      ws.send(JSON.stringify({ v: 1, type: "open", code, token }));
      const opened = await ready;
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        bridge.onFrame(new Uint8Array(data as Buffer));
      });
      ws.on("close", () => {
        if (socket === ws && !closing) void recover("中继连接断开");
      });
      return { ws, url: opened };
    } catch (error) {
      ws.terminate();
      throw error;
    }
  }

  /** Keep trying to put the room back, so a blip is not the end of the conversation. */
  async function recover(reason: string): Promise<void> {
    socket = undefined;
    options.onReconnecting?.(reason);
    const deadline = Date.now() + (options.recoverMs ?? RECOVER_MS);
    let wait = 500;
    while (!closing && Date.now() < deadline) {
      await delay(wait);
      if (closing) return;
      try {
        const next = await openRoom();
        socket = next.ws;
        options.onReconnected?.();
        return;
      } catch {
        wait = Math.min(wait * 2, 5000);
      }
    }
    if (!closing) options.onGone?.(`${reason}，${Math.round((options.recoverMs ?? RECOVER_MS) / 1000)} 秒内没能把房间接回来`);
  }

  const first = await openRoom();
  socket = first.ws;
  let closed: Promise<void> | undefined;

  return {
    code,
    url: first.url,
    controlUrl: control.url,
    // Closing twice — the server shutting down while an inbox is already on its way out — is one close.
    close: () => (closed ??= shut()),
  };

  async function shut(): Promise<void> {
    closing = true;
    const open = socket;
    if (open && (open.readyState === WebSocket.OPEN || open.readyState === WebSocket.CONNECTING)) {
      await new Promise<void>((resolve) => {
        open.once("close", () => resolve());
        open.close();
      });
    }
    await control.close();
    await new Promise<void>((resolve, reject) => localUrl.server.close((error) => (error ? reject(error) : resolve())));
  }
}

/**
 * An event as anyone holding the room address may read it. The text is sealed already; a file's
 * name and where it was saved are not, because they were written down after it was opened. Only
 * a file this side is sending needs to go — as sealed bytes under a name that says nothing.
 */
function overTheRelay(event: SessionEvent): SessionEvent {
  const files = event.from === "host" ? event.files.filter((file) => file.data).map((file) => ({ name: "sealed", mediaType: file.mediaType, path: "", data: file.data })) : [];
  return { ...event, files };
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayError(error: unknown, relay: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`连不上中继 ${relay}：${detail}`);
}

function openError(code: string): string {
  if (code === "room_taken") return "这个房间已经被另一个进程占着了。如果不是你自己开的第二个，就换一个新的配对码";
  if (code === "unauthorized") return "中继需要密码，两边都要加 --pass";
  if (code === "rate_limited") return "开房太频繁，等一分钟再试";
  return code;
}

function agentCard(localUrl: string): AgentCard {
  return {
    name: "agenthop",
    description: "Carries one conversation between two agents, in order.",
    version,
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
