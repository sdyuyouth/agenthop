import { DurableObject } from "cloudflare:workers";
import {
  IDLE_MS,
  MAX_BODY,
  PostCounter,
  RelaySession,
  TunnelError,
  decodeControl,
  encodeControl,
  isValidCode,
  normalizeCode,
  rateShard,
  roomIdFromCode,
  safeEqual,
  tokenDigest,
} from "@agenthop/tunnel";

type Attachment = { role: "host"; ready: boolean; code: string; publicBase: string };

/** A day's worth of salt. Rotating it means yesterday's counters cannot be matched to anyone. */
const SALT_MS = 24 * 60 * 60 * 1000;

export class RateLimit extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, window INTEGER NOT NULL, n INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS salt (day INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    });
  }

  /**
   * Counting how often an address arrives does not require keeping the address. The key is a
   * salted digest and the salt turns over daily; rows from earlier minutes are dropped on the
   * way past, so at any moment this holds one minute of counters and nothing else.
   */
  async allow(ip: string, kind: "create" | "miss"): Promise<boolean> {
    const limit = kind === "create" ? 10 : 60;
    const window = Math.floor(Date.now() / 60_000);
    this.ctx.storage.sql.exec("DELETE FROM counters WHERE window < ?", window);
    const key = await this.key(ip, kind);
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

  private async key(ip: string, kind: string): Promise<string> {
    const day = Math.floor(Date.now() / SALT_MS);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${this.salt(day)}:${ip}:${kind}`));
    return [...new Uint8Array(digest).subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private salt(day: number): string {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM salt WHERE day = ?", day).toArray()[0];
    if (row) return row.value;
    const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.sql.exec("DELETE FROM salt WHERE day < ?", day);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO salt (day, value) VALUES (?, ?)", day, fresh);
    return fresh;
  }
}

export class Room extends DurableObject<Env> {
  private session: RelaySession | null = null;
  private readonly posts = new PostCounter();

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
      let token: string | undefined;
      try {
        const control = decodeControl(text);
        if (control.type !== "open" || normalizeCode(control.code) !== normalizeCode(attachment.code)) {
          this.reject(ws, "invalid_code");
          return;
        }
        token = control.token;
      } catch {
        this.reject(ws, "invalid_code");
        return;
      }
      if (!(await this.claim(token))) {
        // Someone else opened this room first. Holding the code is not enough to take it over.
        ws.send(encodeControl({ v: 1, type: "error", code: "room_taken" }));
        ws.close(1008, "room_taken");
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
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE k = 'host'");
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
    // Reading is polled once a second; writing into someone's room is what needs a ceiling.
    if (request.method !== "GET" && request.method !== "HEAD" && !this.posts.allow(Date.now())) {
      this.log("rate_limited");
      return new Response("rate_limited", { status: 429 });
    }
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
      if (error instanceof TunnelError && error.code === "room_quota") {
        this.log("quota");
        return new Response("room_quota", { status: 429 });
      }
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

  /**
   * The first host to open a room fixes who may hold it. A host that reconnects shows the same
   * token; anyone else is turned away even though the socket is free. A host from an older
   * version brings no token and the room stays as open as it was before.
   */
  private async claim(token: string | undefined): Promise<boolean> {
    const held = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'host'").toArray()[0];
    if (!held) {
      if (token) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('host', ?)", await tokenDigest(token));
      return true;
    }
    if (!token) return false;
    return safeEqual(held.v, await tokenDigest(token));
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

const RELEASE_FILES = new Set([
  "agenthop-macos-arm64",
  "agenthop-macos-x64",
  "agenthop-linux-x64",
  "agenthop-linux-arm64",
  "agenthop-windows-x64.exe",
  "SHA256SUMS",
]);

async function releaseResponse(url: URL): Promise<Response | null> {
  if (url.pathname === "/latest") {
    const upstream = await fetch("https://github.com/sdyuyouth/agenthop/releases/latest", {
      redirect: "manual",
      headers: { "user-agent": "agenthop" },
    });
    const tag = upstream.headers.get("location")?.split("/tag/")[1]?.replace(/\/$/, "") ?? "";
    if (!tag) return new Response("release lookup failed", { status: 502 });
    return Response.json({ tag, assets: [...RELEASE_FILES] });
  }
  if (!url.pathname.startsWith("/download/")) return null;
  const name = decodeURIComponent(url.pathname.slice("/download/".length));
  if (!RELEASE_FILES.has(name)) return new Response("not found", { status: 404 });
  const upstream = await fetch(`https://github.com/sdyuyouth/agenthop/releases/latest/download/${name}`, {
    redirect: "follow",
    headers: { "user-agent": "agenthop" },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/octet-stream",
      ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length")! } : {}),
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // A relay with a password is private in every respect, the download proxy included:
    // otherwise it hands its bandwidth to anyone who asks.
    if (env.RELAY_PASS && !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${env.RELAY_PASS}`)) {
      return new Response("unauthorized", { status: 401 });
    }
    const release = await releaseResponse(url);
    if (release) return release;
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
