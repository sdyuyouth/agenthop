import http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  IDLE_MS,
  MAX_ROOM_BYTES,
  PostCounter,
  RateCounters,
  RelaySession,
  TunnelError,
  decodeControl,
  encodeControl,
  isRoomAddress,
  normalizeCode,
  roomIdFromCode,
  safeEqual,
  tokenDigest,
} from "@agenthop/tunnel";

export type RelayOptions = {
  listenHost?: string;
  listenPort?: number;
  pass?: string;
  now?: () => number;
  idleMs?: number;
  /** Everything one room may carry while it lives. */
  roomBytes?: number;
};

export type RunningRelay = {
  url: string;
  port: number;
  sweep: () => void;
  close: () => Promise<void>;
};

type Room = {
  posts: PostCounter;
  /** Hash of the token the first host showed. Only that host may hold the room again. */
  hostHash: string | null;
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
  const roomBytes = options.roomBytes ?? MAX_ROOM_BYTES;
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
      if (!isRoomAddress(route.code)) {
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
      if (req.method !== "GET" && req.method !== "HEAD" && !room.posts.allow(now())) {
        res.writeHead(429);
        res.end("rate_limited");
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
      const status = quotaOrBodyStatus(error);
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
    if (!code || !isRoomAddress(normalizeCode(code))) {
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
    // The room id is worked out before the socket is accepted. Once it is accepted the first
    // frame can arrive at any moment, and a listener attached after an await would miss it —
    // the host would then wait for a `ready` that never comes.
    const normalized = normalizeCode(code);
    void roomIdFromCode(normalized).then(
      (roomId) => wss.handleUpgrade(req, socket, head, (ws) => attachHost(ws, roomId, normalized, url)),
      // A 400 above means the code in the URL was wrong. This one means the room id could not
      // be worked out, which is ours to answer for.
      () => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        socket.destroy();
      },
    );
  });

  function attachHost(ws: WebSocket, roomId: string, code: string, requestUrl: URL): void {
    // A host whose connection resets raises an error here; unheard, it would take the relay down
    // with it. The close that follows cleans up the room.
    ws.on("error", () => undefined);
    const existing = rooms.get(roomId);
    if (existing?.socket && existing.socket.readyState === WebSocket.OPEN) {
      ws.send(encodeControl({ v: 1, type: "error", code: "room_taken" }));
      ws.close(1008, "room_taken");
      return;
    }
    const publicBase = `${httpOrigin(requestUrl, server)}/r/${encodeURIComponent(code)}/`;
    const existingHash = existing?.hostHash ?? null;
    const room: Room = {
      code,
      session: null,
      socket: ws,
      ready: false,
      deadline: now() + idleMs,
      publicBase,
      posts: new PostCounter(),
      hostHash: existingHash,
    };
    rooms.set(roomId, room);
    ws.once("message", (data, isBinary) => {
      let token: string | undefined;
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
        token = control.token;
      } catch {
        ws.send(encodeControl({ v: 1, type: "error", code: "invalid_code" }));
        ws.close();
        rooms.delete(roomId);
        return;
      }
      // Deciding whether this host may hold the room takes a digest, and a digest takes a turn
      // of the loop. Anything that arrives meanwhile is held rather than dropped.
      const held: Uint8Array[] = [];
      const collect = (next: RawData, binary: boolean): void => {
        if (binary) held.push(toBytes(next));
      };
      ws.on("message", collect);
      void claim(room, token).then((allowed) => {
        ws.off("message", collect);
        if (!allowed) {
          ws.send(encodeControl({ v: 1, type: "error", code: "room_taken" }));
          ws.close(1008, "room_taken");
          return;
        }
        const session = new RelaySession(
          (frame) => {
            if (ws.readyState === ws.OPEN) ws.send(frame);
          },
          publicBase,
          undefined,
          roomBytes,
        );
        room.session = session;
        room.ready = true;
        room.deadline = now() + idleMs;
        ws.send(encodeControl({ v: 1, type: "ready", publicBase }));
        ws.on("message", (next, binary) => {
          room.deadline = now() + idleMs;
          if (!binary) return;
          session.onBinary(toBytes(next));
        });
        for (const bytes of held) session.onBinary(bytes);
      });
    });
    ws.on("close", () => {
      room.session?.close();
      room.session = null;
      room.ready = false;
      room.socket = null;
      // The record stays until the room expires so the host that opened it can come back to
      // it. Dropping it here would hand the room to whoever asked next.
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(options.listenPort ?? 0, options.listenHost ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  const url = `http://${options.listenHost ?? "127.0.0.1"}:${address.port}`;

  const sweep = (): void => {
    const current = now();
    for (const [id, room] of rooms) {
      if (current >= room.deadline) {
        room.socket?.close(1000, "idle");
        room.session?.close();
        rooms.delete(id);
      }
    }
  };
  // A room outlives its socket so the host that opened it can come back, which means something
  // has to end it. Nothing did: expired rooms stayed in memory holding the token that opened
  // them, and a pairing code that came round again would find its own room already claimed.
  const sweeper = setInterval(sweep, Math.max(50, Math.min(idleMs, 30_000)));
  sweeper.unref?.();

  return {
    url,
    port: address.port,
    sweep,
    close: () => {
      clearInterval(sweeper);
      return new Promise((resolve, reject) => {
        for (const room of rooms.values()) room.socket?.close();
        wss.close();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function quotaOrBodyStatus(error: unknown): number {
  if (!(error instanceof TunnelError)) return 502;
  if (error.code === "room_quota") return 429;
  if (error.code === "body_too_large") return 413;
  return 502;
}

/**
 * The first host to open a room fixes who may hold it. A host that reconnects shows the same
 * token; a host from an older version brings none and the room stays as open as it was before.
 */
async function claim(room: Room, token: string | undefined): Promise<boolean> {
  if (!room.hostHash) {
    if (token) room.hostHash = await tokenDigest(token);
    return true;
  }
  if (!token) return false;
  return safeEqual(room.hostHash, await tokenDigest(token));
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
