import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { startHost } from "../src/host.js";
import { RelayFailure, retryAfter, retryDelay, waitForRetry } from "../src/retry.js";
import { readQueue } from "../src/send.js";

describe("relay retry budgets", () => {
  it("honors server cooldowns and slows down occupied or unavailable inboxes", () => {
    expect(retryDelay(0, new RelayFailure("rate_limited", "limited", 90_000))).toBeGreaterThanOrEqual(90_000);
    expect(retryDelay(0, new RelayFailure("relay_quota", "quota"), true)).toBeGreaterThanOrEqual(300_000);
    expect(retryDelay(0, new RelayFailure("room_taken", "occupied"), true)).toBeGreaterThanOrEqual(60_000);
    expect(retryDelay(3)).toBeGreaterThan(retryDelay(0));
    expect(retryAfter("60")).toBe(60_000);
    expect(retryAfter("not a date")).toBe(0);
    expect(retryAfter("-1")).toBe(0);
  });

  it("can close immediately during a long cooldown", async () => {
    const stop = new AbortController();
    const waiting = waitForRetry(300_000, stop.signal);
    stop.abort();
    await waiting;
  });

  it("reads HTTP retry-after and releases local servers after a refused handshake", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "retry-after": "300" });
      response.end("relay_quota");
    });
    server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 90\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const before = process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length;
    try {
      const home = await mkdtemp(path.join(tmpdir(), "agenthop-retry-"));
      await expect(readQueue(`http://127.0.0.1:${address.port}/`)).rejects.toMatchObject({ code: "relay_quota", retryAfterMs: 300_000 });
      await expect(startHost({ relay: `http://127.0.0.1:${address.port}`, home })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 90_000 });
      // libuv releases closed handles after the server.close callbacks have run.
      const deadline = Date.now() + 1000;
      while (process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length > before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length).toBeLessThanOrEqual(before);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("cancels a handshake while the relay is silent", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const connected = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const address = server.address() as { port: number };
    const stop = new AbortController();
    const home = await mkdtemp(path.join(tmpdir(), "agenthop-cancel-"));
    const opening = startHost({ relay: `http://127.0.0.1:${address.port}`, home, signal: stop.signal });
    const rejected = expect(opening).rejects.toThrow();
    try {
      await connected;
      stop.abort();
      await rejected;
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not reset backoff when each successful connection immediately drops", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const times: number[] = [];
    server.on("connection", (socket) => {
      times.push(Date.now());
      socket.once("message", () => {
        socket.send(JSON.stringify({ v: 1, type: "ready", publicBase: "http://example.test/" }));
        setTimeout(() => socket.close(), 20);
      });
    });
    const address = server.address() as { port: number };
    const home = await mkdtemp(path.join(tmpdir(), "agenthop-flap-"));
    const host = await startHost({ relay: `http://127.0.0.1:${address.port}`, home });
    try {
      const deadline = Date.now() + 7000;
      while (times.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(times.length).toBeGreaterThanOrEqual(3);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1000);
    } finally {
      await host.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
