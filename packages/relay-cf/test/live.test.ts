import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "@agenthop/tunnel";

let port = 0;
let base = "";
let child: ChildProcess | undefined;

afterAll(() => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
});

// Starting `wrangler dev` needs to fetch workerd, so CI sits this one out unless it is asked for.
const live = !process.env.CI || process.env.AGENTHOP_LIVE === "1";

describe.skipIf(!live)("wrangler dev", () => {
  it("rewrites the card, echoes JSON-RPC, and streams in order", async () => {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(
      "pnpm",
      ["exec", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", "0", "--local"],
      { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    await waitUntilReady(child);
    const code = "1111-acid-acorn-acre";
    const host = await connectHost(code);

    const card = await fetch(`${base}/r/${code}/.well-known/agent-card.json`);
    const cardText = await card.text();
    expect(card.status).toBe(200);
    expect(cardText).not.toContain("127.0.0.1:9");
    // The origin is whatever the relay was reached on, which under `wrangler dev` is the
    // configured custom domain rather than the local address. What matters is the room path.
    expect(JSON.parse(cardText).supportedInterfaces[0].url).toMatch(new RegExp(`^https?://[^/]+/r/${code}/$`));

    const echoed = await fetch(`${base}/r/${code}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","method":"SendMessage"}',
    });
    expect(await echoed.text()).toBe('{"jsonrpc":"2.0","method":"SendMessage"}');

    const streamed = await fetch(`${base}/r/${code}/`, { method: "POST", body: "stream-please" });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toBe("onetwo");

    const big = await fetch(`${base}/r/${code}/`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(big.status).toBe(413);

    let refused = 0;
    for (let i = 0; i < 70; i++) {
      const flood = await fetch(`${base}/r/${code}/`, { method: "POST", body: "flood" });
      if (flood.status === 429) refused++;
      await flood.arrayBuffer();
    }
    expect(refused).toBeGreaterThan(0);
    // Reading is how the joining side follows the room, so it must not be rationed.
    expect((await fetch(`${base}/r/${code}/agenthop/queue`)).status).not.toBe(429);

    host.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fetch(`${base}/r/${code}/`)).status).toBe(404);
  });
});

async function waitUntilReady(proc: ChildProcess): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || "wrangler dev timed out")), 25000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Ready on") || output.includes(`127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler exited ${code}: ${output}`));
    });
  });
}

async function connectHost(code: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/host/${code}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  const requests = new Map<number, { path: string; body: Uint8Array[] }>();
  ws.addEventListener("message", (event) => {
    void onMessage(ws, requests, event.data);
  });
  const ready = nextText(ws);
  ws.send(JSON.stringify({ v: 1, type: "open", code }));
  expect(JSON.parse(await ready).type).toBe("ready");
  return ws;
}

async function onMessage(
  ws: WebSocket,
  requests: Map<number, { path: string; body: Uint8Array[] }>,
  data: unknown,
): Promise<void> {
  const bytes = await asBytes(data);
  if (!bytes || (bytes[0] === 123 && new TextDecoder().decode(bytes).includes('"ready"'))) return;
  let frame: ReturnType<typeof decodeFrame>;
  try {
    frame = decodeFrame(bytes);
  } catch {
    return;
  }
  if (frame.type === "request-start") requests.set(frame.requestId, { path: frame.path, body: [] });
  if (frame.type === "request-body") requests.get(frame.requestId)?.body.push(frame.body);
  if (frame.type !== "request-end") return;
  const req = requests.get(frame.requestId)!;
  const payload = new TextDecoder().decode(concat(req.body));
  if (req.path.includes("agent-card.json")) {
    const card = JSON.stringify({
      name: "local",
      url: "http://127.0.0.1:9/",
      supportedInterfaces: [{ url: "http://127.0.0.1:9/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    });
    reply(ws, frame.requestId, "application/json", card);
  } else if (payload === "stream-please") {
    send(ws, encodeFrame({ type: "response-start", requestId: frame.requestId, status: 200, headers: [["content-type", "text/event-stream"]] }));
    send(ws, encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode("one") }));
    send(ws, encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode("two") }));
    send(ws, encodeFrame({ type: "response-end", requestId: frame.requestId }));
  } else {
    reply(ws, frame.requestId, "application/json", payload);
  }
}

function reply(ws: WebSocket, requestId: number, contentType: string, body: string): void {
  send(ws, encodeFrame({ type: "response-start", requestId, status: 200, headers: [["content-type", contentType]] }));
  if (body) send(ws, encodeFrame({ type: "response-body", requestId, body: new TextEncoder().encode(body) }));
  send(ws, encodeFrame({ type: "response-end", requestId }));
}

function send(ws: WebSocket, bytes: Uint8Array): void {
  ws.send(bytes);
}

function nextText(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      void asBytes(event.data).then((bytes) => {
        if (!bytes) return;
        const text = new TextDecoder().decode(bytes);
        if (!text.startsWith("{")) return;
        ws.removeEventListener("message", onMessage);
        resolve(text);
      });
    };
    ws.addEventListener("message", onMessage);
  });
}

async function asBytes(data: unknown): Promise<Uint8Array | null> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const chosen = address && typeof address !== "string" ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(chosen)));
    });
  });
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
