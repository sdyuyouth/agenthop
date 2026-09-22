import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  IDLE_MS,
  RateCounters,
  RelaySession,
  TunnelError,
  decodeControl,
  encodeControl,
  isValidCode,
  normalizeCode,
  roomIdFromCode,
  safeEqual,
} from "@agenthop/tunnel";

export type RelayOptions = {
  listenHost?: string;
  listenPort?: number;
  pass?: string;
  now?: () => number;
  idleMs?: number;
};

export type RunningRelay = {
  url: string;
  port: number;
  sweep: () => void;
  close: () => Promise<void>;
};

type Room = {
  code: string;
  session: RelaySession | null;
  socket: WebSocket | null;
  ready: boolean;
  deadline: number;
  publicBase: string;
};

export async function startRelay(options: RelayOptions = {}): Promise<RunningRelay> {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? IDLE_MS;
  const rooms = new Map<string, Room>();
  const rates = new RateCounters();
  const pass = options.pass;

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req.headers.authorization, pass)) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const route = matchHttp(url);
      if (!route) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      if (!isValidCode(route.code)) {
        noteMiss(rates, req, now);
        res.writeHead(400);
        res.end("invalid_code");
        return;
      }
      const room = rooms.get(await roomIdFromCode(route.code));
      if (!room?.ready || !room.session || room.socket?.readyState !== WebSocket.OPEN) {
        if (!noteMiss(rates, req, now)) {
          res.writeHead(429);
          res.end("rate_limited");
          return;
        }
        res.writeHead(404);
        res.end("not found");
        return;
      }
      room.deadline = now() + idleMs;
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      const bodyBytes = concat(chunks);
      if (bodyBytes.byteLength > 1024 * 1024) {
        res.writeHead(413);
        res.end("body_too_large");
        return;
      }
      const forwarded = await room.session.forward({
        method: req.method ?? "GET",
        path: route.path,
        headers: Object.entries(req.headers).flatMap(([name, value]) => {
          if (Array.isArray(value)) return value.map((item) => [name, item] as [string, string]);
          if (typeof value === "string") return [[name, value] as [string, string]];
          return [];
        }),
        body: bodyBytes.byteLength ? streamFrom(bodyBytes) : null,
      });
      const payload = await readStream(forwarded.body);
      res.writeHead(forwarded.status, Object.fromEntries(forwarded.headers));
      res.end(payload);
    } catch (error) {
      const status = error instanceof TunnelError && error.code === "body_too_large" ? 413 : 502;
      if (!res.headersSent) res.writeHead(status);
      res.end(error instanceof Error ? error.message : "failed");
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!authorized(req.headers.authorization, pass)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const code = codeFromHostPath(url.pathname);
    if (!code || !isValidCode(normalizeCode(code))) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress ?? "local";
    if (!rates.allow(ip, "create", now())) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void attachHost(ws, normalizeCode(code), url);
    });
  });

  async function attachHost(ws: WebSocket, code: string, requestUrl: URL): Promise<void> {
    const roomId = await roomIdFromCode(code);
    const existing = rooms.get(roomId);
    if (existing?.socket && existing.socket.readyState === WebSocket.OPEN) {
      ws.send(encodeControl({ v: 1, type: "error", code: "room_taken" }));
      ws.close(1008, "room_taken");
      return;
    }
    const publicBase = `${httpOrigin(requestUrl, server)}/r/${encodeURIComponent(code)}/`;
    const room: Room = { code, session: null, socket: ws, ready: false, deadline: now() + idleMs, publicBase };
    rooms.set(roomId, room);
    ws.once("message", (data, isBinary) => {
      if (isBinary) {
        ws.send(encodeControl({ v: 1, type: "error", code: "invalid_code" }));
        ws.close();
        return;
      }
      try {
        const control = decodeControl(data.toString());
        if (control.type !== "open" || normalizeCode(control.code) !== code) {
          ws.send(encodeControl({ v: 1, type: "error", code: "invalid_code" }));
          ws.close();
          rooms.delete(roomId);
          return;
        }
      } catch {
        ws.send(encodeControl({ v: 1, type: "error", code: "invalid_code" }));
        ws.close();
        rooms.delete(roomId);
        return;
      }
      const session = new RelaySession((frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame);
      }, publicBase);
      room.session = session;
      room.ready = true;
      room.deadline = now() + idleMs;
      ws.send(encodeControl({ v: 1, type: "ready", publicBase }));
      ws.on("message", (next, binary) => {
        room.deadline = now() + idleMs;
        if (!binary) return;
        const bytes = toBytes(next);
        session.onBinary(bytes);
      });
    });
    ws.on("close", () => {
      room.session?.close();
      room.session = null;
      room.ready = false;
      room.socket = null;
      if (rooms.get(roomId) === room) rooms.delete(roomId);
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(options.listenPort ?? 0, options.listenHost ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  const url = `http://${options.listenHost ?? "127.0.0.1"}:${address.port}`;

  return {
    url,
    port: address.port,
    sweep() {
      const current = now();
      for (const [id, room] of rooms) {
        if (current >= room.deadline) {
          room.socket?.close(1000, "idle");
          room.session?.close();
          rooms.delete(id);
        }
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const room of rooms.values()) room.socket?.close();
        wss.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function noteMiss(rates: RateCounters, req: http.IncomingMessage, now: () => number): boolean {
  return rates.allow(req.socket.remoteAddress ?? "local", "miss", now());
}

function authorized(header: string | undefined, pass: string | undefined): boolean {
  if (!pass) return true;
  return safeEqual(header ?? "", `Bearer ${pass}`);
}

function matchHttp(url: URL): { code: string; path: string } | null {
  if (!url.pathname.startsWith("/r/")) return null;
  const rest = url.pathname.slice("/r/".length);
  const slash = rest.indexOf("/");
  const raw = slash === -1 ? rest : rest.slice(0, slash);
  const path = (slash === -1 ? "/" : rest.slice(slash)) + url.search;
  return { code: normalizeCode(decodeURIComponent(raw)), path };
}

function codeFromHostPath(pathname: string): string | null {
  if (!pathname.startsWith("/host/")) return null;
  return decodeURIComponent(pathname.slice("/host/".length));
}

function httpOrigin(url: URL, server: http.Server): string {
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : url.port;
  return `http://127.0.0.1:${port}`;
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return concat(data.map((part) => new Uint8Array(part)));
  return new Uint8Array(data);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    parts.push(step.value);
  }
  return Buffer.from(concat(parts));
}
