import { DurableObject } from "cloudflare:workers";
import {
  IDLE_MS,
  MAX_BODY,
  RelaySession,
  TunnelError,
  decodeControl,
  encodeControl,
  isValidCode,
  normalizeCode,
  rateShard,
  roomIdFromCode,
  safeEqual,
} from "@agenthop/tunnel";

type Attachment = { role: "host"; ready: boolean; code: string; publicBase: string };

export class RateLimit extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, window INTEGER NOT NULL, n INTEGER NOT NULL)",
      );
    });
  }

  allow(ip: string, kind: "create" | "miss"): boolean {
    const limit = kind === "create" ? 10 : 60;
    const window = Math.floor(Date.now() / 60_000);
    const key = `${ip}:${kind}`;
    const row = this.ctx.storage.sql
      .exec<{ window: number; n: number }>("SELECT window, n FROM counters WHERE k = ?", key)
      .toArray()[0];
    if (!row || row.window !== window) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO counters (k, window, n) VALUES (?, ?, 1)",
        key,
        window,
      );
      return true;
    }
    if (row.n >= limit) return false;
    this.ctx.storage.sql.exec("UPDATE counters SET n = n + 1 WHERE k = ?", key);
    return true;
  }
}

export class Room extends DurableObject<Env> {
  private session: RelaySession | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-agenthop-kind") === "host") return this.acceptHost(request);
    return this.proxy(request);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    if (!attachment.ready) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      try {
        const control = decodeControl(text);
        if (control.type !== "open" || normalizeCode(control.code) !== normalizeCode(attachment.code)) {
          this.reject(ws, "invalid_code");
          return;
        }
      } catch {
        this.reject(ws, "invalid_code");
        return;
      }
      ws.serializeAttachment({ ...attachment, ready: true });
      ws.send(encodeControl({ v: 1, type: "ready", publicBase: attachment.publicBase }));
      void this.touch();
      return;
    }
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new TextEncoder().encode(message);
    this.ensureSession(attachment.publicBase).onBinary(bytes);
    void this.touch();
  }

  async webSocketClose(): Promise<void> {
    this.session?.close();
    this.session = null;
  }

  async alarm(): Promise<void> {
    this.log("idle");
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "idle");
    this.session?.close();
    this.session = null;
  }

  private acceptHost(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const taken = this.ctx.getWebSockets().length > 0;
    this.ctx.acceptWebSocket(server);
    const code = request.headers.get("x-agenthop-code") ?? "";
    const publicBase = request.headers.get("x-agenthop-public-base") ?? "";
    if (taken) {
      server.send(encodeControl({ v: 1, type: "error", code: "room_taken" }));
      server.close(1008, "room_taken");
    } else {
      server.serializeAttachment({ role: "host", ready: false, code, publicBase } satisfies Attachment);
      this.log("open");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async proxy(request: Request): Promise<Response> {
    const host = this.readyHost();
    if (!host) return new Response("not found", { status: 404 });
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) return new Response("body_too_large", { status: 413 });
    const path = request.headers.get("x-agenthop-path") ?? "/";
    const publicBase = host.deserializeAttachment().publicBase as string;
    await this.touch();
    try {
      const forwarded = await this.ensureSession(publicBase).forward({
        method: request.method,
        path,
        headers: request.headers,
        body: request.body,
      });
      const headers = new Headers();
      for (const [name, value] of forwarded.headers) headers.set(name, value);
      return new Response(forwarded.body, { status: forwarded.status, headers });
    } catch (error) {
      const status = error instanceof TunnelError && error.code === "body_too_large" ? 413 : 502;
      return new Response(error instanceof Error ? error.message : "failed", { status });
    }
  }

  private ensureSession(publicBase: string): RelaySession {
    if (!this.session) {
      this.session = new RelaySession((data) => {
        const host = this.readyHost();
        if (!host) throw new Error("no host");
        host.send(data);
      }, publicBase);
    }
    return this.session;
  }

  private readyHost(): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      return attachment?.ready === true;
    });
  }

  private reject(ws: WebSocket, code: "invalid_code"): void {
    ws.send(encodeControl({ v: 1, type: "error", code }));
    ws.close(1008, code);
  }

  private async touch(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  private log(ev: string): void {
    console.log(JSON.stringify({ t: Date.now(), ev }));
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (env.RELAY_PASS && !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${env.RELAY_PASS}`)) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (url.pathname.startsWith("/host/")) {
      const code = normalizeCode(decodeURIComponent(url.pathname.slice("/host/".length)));
      if (!isValidCode(code)) return new Response("invalid_code", { status: 400 });
      const allowed = await limiter(env, ip).allow(ip, "create");
      if (!allowed) return new Response("rate_limited", { status: 429 });
      const roomId = await roomIdFromCode(code);
      const stamped = stamp(request, {
        "x-agenthop-kind": "host",
        "x-agenthop-code": code,
        "x-agenthop-public-base": `${url.origin}/r/${encodeURIComponent(code)}/`,
      });
      return env.ROOM.getByName(roomId).fetch(stamped);
    }
    if (url.pathname.startsWith("/r/")) {
      const rest = url.pathname.slice("/r/".length);
      const slash = rest.indexOf("/");
      const code = normalizeCode(decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash)));
      if (!isValidCode(code)) {
        const allowed = await limiter(env, ip).allow(ip, "miss");
        return new Response("invalid_code", { status: allowed ? 400 : 429 });
      }
      const path = (slash === -1 ? "/" : rest.slice(slash)) + url.search;
      const roomId = await roomIdFromCode(code);
      const stamped = stamp(request, { "x-agenthop-kind": "http", "x-agenthop-path": path });
      const response = await env.ROOM.getByName(roomId).fetch(stamped);
      if (response.status === 404) {
        const allowed = await limiter(env, ip).allow(ip, "miss");
        if (!allowed) return new Response("rate_limited", { status: 429 });
      }
      return response;
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function limiter(env: Env, ip: string): { allow(ip: string, kind: "create" | "miss"): Promise<boolean> } {
  return env.RATE_LIMIT.getByName(rateShard(ip)) as unknown as {
    allow(ip: string, kind: "create" | "miss"): Promise<boolean>;
  };
}

function stamp(request: Request, fields: Record<string, string>): Request {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(fields)) headers.set(name, value);
  return new Request(request, { headers });
}
