import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { decodeFrame, encodeFrame } from "@agenthop/tunnel";
import { startRelay, type RunningRelay } from "../src/index.js";

const openRelays: RunningRelay[] = [];

afterEach(async () => {
  await Promise.all(openRelays.splice(0).map((relay) => relay.close()));
});

describe("node relay", () => {
  it("pairs, rewrites the card, echoes JSON, and streams in order", async () => {
    const relay = await startRelay();
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";
    const host = await connectHost(relay.url, code);
    const card = await fetch(`${relay.url}/r/${code}/.well-known/agent-card.json`);
    expect(card.status).toBe(200);
    const cardText = await card.text();
    expect(cardText).not.toContain("127.0.0.1:9");
    expect(JSON.parse(cardText).supportedInterfaces[0].url).toBe(`${relay.url}/r/${code}/`);

    const echoed = await fetch(`${relay.url}/r/${code}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","method":"SendMessage"}',
    });
    expect(await echoed.text()).toBe('{"jsonrpc":"2.0","method":"SendMessage"}');

    const streamed = await fetch(`${relay.url}/r/${code}/`, {
      method: "POST",
      body: "stream-please",
    });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toBe("onetwo");
    host.close();
  });

  it("rejects a second host, unknown codes, an oversized body, and a closed host", async () => {
    const relay = await startRelay();
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";
    const host = await connectHost(relay.url, code);
    const second = new WebSocket(`${relay.url.replace("http", "ws")}/host/${code}`);
    const error = await onceMessage(second);
    expect(JSON.parse(String(error)).code).toBe("room_taken");

    expect((await fetch(`${relay.url}/r/2222-acid-acorn-acre/`)).status).toBe(404);

    const big = await fetch(`${relay.url}/r/${code}/`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(big.status).toBe(413);

    host.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await fetch(`${relay.url}/r/${code}/`)).status).toBe(404);
  });

  it("requires the relay password and expires idle rooms", async () => {
    let now = 0;
    const relay = await step("start the relay", startRelay({ pass: "secret", now: () => now, idleMs: 1_000 }));
    openRelays.push(relay);
    const unauthorized = await step("fetch without the password", fetch(`${relay.url}/r/1111-acid-acorn-acre/`));
    expect(unauthorized.status).toBe(401);
    const code = "1111-acid-acorn-acre";
    const host = await step("connect the host", connectHost(relay.url, code, "secret"));
    const proxied = await step(
      "fetch with the password",
      fetch(`${relay.url}/r/${code}/`, { headers: { authorization: "Bearer secret" } }),
    );
    expect(proxied.status).toBe(200);
    now = 1_000;
    relay.sweep();
    host.close();
    const afterSweep = await step(
      "fetch after the room expired",
      fetch(`${relay.url}/r/${code}/`, { headers: { authorization: "Bearer secret" } }),
    );
    expect(afterSweep.status).toBe(404);
  });

  it("rate limits missing codes", async () => {
    // A frozen clock keeps the whole run inside one counting window; with the real one a run
    // that crosses the minute gets a fresh allowance and the last request is a plain 404.
    const relay = await startRelay({ now: () => 0 });
    openRelays.push(relay);
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await fetch(`${relay.url}/r/2222-acid-acorn-acre/`)).status;
    }
    expect(last).toBe(429);
  });

  it("stops a flood of posts into one room but keeps serving reads", async () => {
    const relay = await startRelay();
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";
    await connectHost(relay.url, code);

    let refused = 0;
    // The counter runs on wall-clock minutes. Seventy posts that straddle a minute boundary split
    // into two windows and neither passes sixty, so the flood has to be big enough that any split
    // still leaves one window over the limit.
    for (let i = 0; i < 130; i++) {
      const response = await fetch(`${relay.url}/r/${code}/`, { method: "POST", body: "hi" });
      if (response.status === 429) refused++;
      await response.arrayBuffer();
    }
    expect(refused).toBeGreaterThan(0);

    const read = await fetch(`${relay.url}/r/${code}/agenthop/queue`);
    expect(read.status).not.toBe(429);
    await read.arrayBuffer();
  });

  it("answers a host that speaks the moment the socket opens", async () => {
    const relay = await startRelay();
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";
    // The open frame is sent in the same tick as the socket opening, which is what a real host
    // does. Anything the relay does asynchronously before listening would drop it.
    const ws = new WebSocket(`${relay.url.replace("http", "ws")}/host/${code}`);
    const ready = new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(JSON.stringify({ v: 1, type: "open", code }));
        resolve();
      });
      ws.once("error", reject);
    });

    expect(JSON.parse(await step("the relay answers ready", ready)).type).toBe("ready");
    ws.close();
  });

  it("keeps the room for the host that opened it, even while its socket is away", async () => {
    const relay = await startRelay();
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";
    const token = "the-host-token";

    const first = await connectHost(relay.url, code, undefined, token);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Someone else holding the code arrives while the socket is gone.
    const stranger = new WebSocket(`${relay.url.replace("http", "ws")}/host/${code}`);
    const refusal = new Promise<string>((resolve, reject) => {
      stranger.once("message", (data) => resolve(data.toString()));
      stranger.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      stranger.once("open", () => {
        stranger.send(JSON.stringify({ v: 1, type: "open", code, token: "a-different-token" }));
        resolve();
      });
      stranger.once("error", reject);
    });
    expect(JSON.parse(await step("the stranger is turned away", refusal))).toEqual({
      v: 1,
      type: "error",
      code: "room_taken",
    });
    stranger.close();

    // The host that opened it comes back with the same token.
    const again = await step("the host returns", connectHost(relay.url, code, undefined, token));
    expect((await fetch(`${relay.url}/r/${code}/`)).status).toBe(200);
    again.close();
  });

  it("stops carrying a room that has spent its allowance", async () => {
    const relay = await startRelay({ roomBytes: 4 * 1024 });
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";
    const host = await connectHost(relay.url, code);

    expect((await fetch(`${relay.url}/r/${code}/`, { method: "POST", body: "x".repeat(3 * 1024) })).status).toBe(200);
    const over = await fetch(`${relay.url}/r/${code}/`, { method: "POST", body: "x".repeat(3 * 1024) });
    expect(over.status).toBe(429);
    expect(await over.text()).toContain("room_quota");
    host.close();
  });

  it("refuses a code that still carries its secret", async () => {
    // The relay routes on the address alone. A client that let the secret reach a URL is broken,
    // and it should find that out here rather than quietly hand the key over.
    const relay = await startRelay();
    openRelays.push(relay);
    const whole = "1111-acid-acorn-acre-k7f3q2mbxz4a6tu5wnhjy2pc3d";

    expect((await fetch(`${relay.url}/r/${whole}/`)).status).toBe(400);
    const ws = new WebSocket(`${relay.url.replace("http", "ws")}/host/${whole}`);
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", () => resolve("opened"));
        ws.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("forgets the room, and the token that held it, once it expires", async () => {
    // A room outlives its socket so its host can come back. Something has to end it, or a
    // pairing code that comes round again finds its own room already claimed by a token
    // nobody has any more.
    const relay = await startRelay({ idleMs: 200 });
    openRelays.push(relay);
    const code = "1111-acid-acorn-acre";

    const first = await connectHost(relay.url, code, undefined, "the-first-token");
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 700));

    const later = await step(
      "a later host opens the same code",
      connectHost(relay.url, code, undefined, "a-token-from-the-next-room"),
    );
    expect((await fetch(`${relay.url}/r/${code}/`)).status).toBe(200);
    later.close();
  });
});

/** A hung await should say which one it was, not just that the test ran out of time. */
async function step<T>(label: string, work: Promise<T>, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: 没有在 ${ms}ms 内完成`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectHost(relayUrl: string, code: string, pass?: string, token?: string): Promise<WebSocket> {
  const ws = new WebSocket(`${relayUrl.replace("http", "ws")}/host/${code}`, {
    headers: pass ? { authorization: `Bearer ${pass}` } : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const requests = new Map<number, { path: string; body: Uint8Array[] }>();
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const frame = decodeFrame(new Uint8Array(data as Buffer));
    if (frame.type === "request-start") requests.set(frame.requestId, { path: frame.path, body: [] });
    if (frame.type === "request-body") requests.get(frame.requestId)?.body.push(frame.body);
    if (frame.type !== "request-end") return;
    const req = requests.get(frame.requestId)!;
    const payload = new TextDecoder().decode(concat(req.body));
    if (req.path.startsWith("/.well-known/agent-card.json")) {
      const card = JSON.stringify({
        name: "local",
        url: "http://127.0.0.1:9/",
        supportedInterfaces: [{ url: "http://127.0.0.1:9/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      });
      send(ws, frame.requestId, 200, "application/json", card);
    } else if (payload === "stream-please") {
      ws.send(encodeFrame({ type: "response-start", requestId: frame.requestId, status: 200, headers: [["content-type", "text/event-stream"]] }));
      ws.send(encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode("one") }));
      ws.send(encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode("two") }));
      ws.send(encodeFrame({ type: "response-end", requestId: frame.requestId }));
    } else {
      send(ws, frame.requestId, 200, "application/json", payload || "ok");
    }
  });
  ws.send(JSON.stringify({ v: 1, type: "open", code, token }));
  const ready = JSON.parse(String(await onceMessage(ws)));
  expect(ready.type).toBe("ready");
  return ws;
}

function send(ws: WebSocket, requestId: number, status: number, contentType: string, body: string): void {
  ws.send(encodeFrame({ type: "response-start", requestId, status, headers: [["content-type", contentType]] }));
  if (body) ws.send(encodeFrame({ type: "response-body", requestId, body: new TextEncoder().encode(body) }));
  ws.send(encodeFrame({ type: "response-end", requestId }));
}

function onceMessage(ws: WebSocket): Promise<WebSocket.RawData> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data));
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("closed")));
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