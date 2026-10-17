import { DurableObject } from "cloudflare:workers";
import {
  IDLE_MS,
  MAX_BODY,
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

type Attachment = { role: "host"; ready: boolean; code: string; publicBase: string; activityAt?: number; openedAt?: number };
const HANDSHAKE_MS = 20_000;

export class RateLimit extends DurableObject<Env> {
  // Keep the old class export for existing namespaces and rollback. New ingress never calls it.
  private readonly counters = new RateCounters();
  async allow(ip: string, kind: "create" | "miss"): Promise<boolean> {
    return this.counters.allow(ip, kind, Date.now());
  }
}

export class Room extends DurableObject<Env> {
  private session: RelaySession | null = null;
  private readonly posts = new PostCounter();
  private alarmAt: number | null | undefined;

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
      ws.serializeAttachment({ ...attachment, ready: true, activityAt: Date.now() });
      ws.send(encodeControl({ v: 1, type: "ready", publicBase: attachment.publicBase }));
      await this.touch(ws);
      return;
    }
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new TextEncoder().encode(message);
    this.ensureSession(attachment.publicBase).onBinary(bytes);
    await this.touch(ws);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    ws.close(1000, "closed");
    // Closing a rejected second socket must not tear down the real host's session.
    if (!attachment?.ready) return;
    this.session?.close();
    this.session = null;
    const until = (attachment.activityAt ?? Date.now()) + IDLE_MS;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('idle_until', ?)", String(until));
    await this.armEarlier(until);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = Date.now();
    let next = Infinity;
    let active = false;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      if (attachment.ready && attachment.activityAt === undefined) {
        // Give pre-upgrade attachments one idle window, then expire them normally.
        attachment.activityAt = now;
        ws.serializeAttachment(attachment);
      }
      const deadline = attachment.ready
        ? (attachment.activityAt ?? now) + IDLE_MS
        : (attachment.openedAt ?? now - HANDSHAKE_MS) + HANDSHAKE_MS;
      if (deadline > now) {
        next = Math.min(next, deadline);
        if (attachment.ready) active = true;
      } else {
        ws.serializeAttachment({ ...attachment, ready: false });
        ws.close(attachment.ready ? 1000 : 1008, attachment.ready ? "idle" : "invalid_code");
      }
    }
    if (!active) {
      this.session?.close();
      this.session = null;
      const heldUntil = Number(this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'idle_until'").toArray()[0]?.v ?? 0);
      if (heldUntil > now) next = Math.min(next, heldUntil);
      else {
        this.log("idle");
        this.ctx.storage.sql.exec("DELETE FROM meta");
      }
    }
    if (Number.isFinite(next)) await this.armEarlier(next);
  }

  private acceptHost(request: Request): Promise<Response> {
    // Checking the slot and accepting its socket must remain atomic across storage awaits.
    return this.ctx.blockConcurrencyWhile(() => this.acceptHostLocked(request));
  }

  private async acceptHostLocked(request: Request): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    const taken = sockets.length > 0;
    if (sockets.some((socket) => (socket.deserializeAttachment() as Attachment | null)?.ready === false)) {
      await this.armEarlier(Date.now() + HANDSHAKE_MS);
    }
    if (!taken) {
      // Preserve the ownership deadline of a disconnected host from the previous deployment.
      const oldAlarm = await this.ctx.storage.getAlarm();
      const lease = this.ctx.storage.sql.exec<{ k: string }>("SELECT k FROM meta WHERE k IN ('host', 'idle_until')").toArray();
      if (oldAlarm && lease.some((row) => row.k === "host") && !lease.some((row) => row.k === "idle_until")) {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('idle_until', ?)", String(oldAlarm));
      }
      await this.armEarlier(Date.now() + HANDSHAKE_MS);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const code = request.headers.get("x-agenthop-code") ?? "";
    const publicBase = request.headers.get("x-agenthop-public-base") ?? "";
    if (taken) {
      server.send(encodeControl({ v: 1, type: "error", code: "room_taken" }));
      server.close(1008, "room_taken");
    } else {
      server.serializeAttachment({ role: "host", ready: false, code, publicBase, openedAt: Date.now() } satisfies Attachment);
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

  private async touch(ws = this.readyHost()): Promise<void> {
    if (!ws) return;
    const attachment = ws.deserializeAttachment() as Attachment;
    ws.serializeAttachment({ ...attachment, activityAt: Date.now() });
    await this.armEarlier(Date.now() + IDLE_MS);
  }

  private async armEarlier(at: number): Promise<void> {
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt !== null && this.alarmAt <= at) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
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
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof Error && /Exceeded allowed rows|Durable Objects free tier/i.test(error.message)) {
        return new Response("relay_quota", { status: 503, headers: { "retry-after": "300" } });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
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
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405, headers: { allow: "GET" } });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("websocket_required", { status: 426, headers: { upgrade: "websocket" } });
    const code = parseAddress(url.pathname.slice("/host/".length));
    if (!code) return new Response("invalid_code", { status: 400 });
    const allowed = await env.CREATE_LIMIT.limit({ key: await ipKey(ip) });
    if (!allowed.success) return throttled();
    const roomId = await roomIdFromCode(code);
    if (!(await env.ROOM_CONNECT_LIMIT.limit({ key: roomId })).success) return throttled();
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
    const code = parseAddress(slash === -1 ? rest : rest.slice(0, slash));
    const key = await ipKey(ip);
    if (!code) {
      const allowed = await env.MISS_LIMIT.limit({ key });
      return allowed.success ? new Response("invalid_code", { status: 400 }) : throttled();
    }
    // Bound even valid-looking misses before invoking a room. A normal reader polls at 60/min.
    if (!(await env.LOOKUP_LIMIT.limit({ key })).success) return throttled();
    const path = (slash === -1 ? "/" : rest.slice(slash)) + url.search;
    const roomId = await roomIdFromCode(code);
    const stamped = stamp(request, { "x-agenthop-kind": "http", "x-agenthop-path": path });
    const response = await env.ROOM.getByName(roomId).fetch(stamped);
    if (response.status === 404) {
      const allowed = await env.MISS_LIMIT.limit({ key });
      if (!allowed.success) return throttled();
    }
    return response;
  }
  return new Response("not found", { status: 404 });
}

function parseAddress(raw: string): string | null {
  try {
    if (raw.length > 512) return null;
    const code = normalizeCode(decodeURIComponent(raw));
    return isRoomAddress(code) ? code : null;
  } catch {
    return null;
  }
}

async function ipKey(ip: string): Promise<string> {
  const day = Math.floor(Date.now() / 86_400_000);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}:${ip}`));
  return [...new Uint8Array(digest).subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function throttled(): Response {
  return new Response("rate_limited", { status: 429, headers: { "retry-after": "60" } });
}

function stamp(request: Request, fields: Record<string, string>): Request {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(fields)) headers.set(name, value);
  return new Request(request, { headers });
}
