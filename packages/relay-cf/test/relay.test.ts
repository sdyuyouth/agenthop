import { SELF, env, runInDurableObject } from "cloudflare:test";
import { encodeFrame, IDLE_MS, roomIdFromCode } from "@agenthop/tunnel";
import { describe, expect, it, vi } from "vitest";
import worker, { Room } from "../src/index.js";

describe("workers relay", () => {
  it("answers 404 for a room with no host", async () => {
    const response = await SELF.fetch("http://example.com/r/1111-acid-acorn-acre/", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    expect(response.status).toBe(404);
  });

  it("rate limits repeated lookups of a missing code", async () => {
    // The counter resets on the minute, so a run that starts near a boundary gets a fresh
    // allowance part way through. Two allowances is the worst case; keep asking until one of
    // them runs out.
    let refused = false;
    for (let i = 0; i < 130 && !refused; i++) {
      const response = await SELF.fetch("http://example.com/r/4444-acid-acorn-acre/", {
        headers: { "cf-connecting-ip": "203.0.113.20" },
      });
      refused = response.status === 429;
    }
    expect(refused).toBe(true);
  });

  it("rejects invalid upgrades and throttled clients before invoking any DO", async () => {
    const getByName = vi.fn(() => { throw new Error("must not invoke a DO"); });
    const limit = vi.fn(async (_options: { key: string }) => ({ success: false }));
    const bindings = { ...env, ROOM: { getByName }, CREATE_LIMIT: { limit } } as unknown as Env;
    expect((await worker.fetch(new Request("http://example.com/host/5555-acid-acorn-acre"), bindings)).status).toBe(426);
    expect(limit).not.toHaveBeenCalled();
    const response = await worker.fetch(new Request("http://example.com/host/5555-acid-acorn-acre", { headers: { upgrade: "websocket" } }), bindings);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(getByName).not.toHaveBeenCalled();
    expect(limit.mock.calls[0]?.[0]).not.toEqual({ key: "local" });
  });

  it("limits one room even when every connection uses a different IP", async () => {
    let refused = false;
    for (let i = 0; i < 50 && !refused; i++) {
      const response = await SELF.fetch("http://example.com/host/5556-acid-acorn-acre", {
        headers: { upgrade: "websocket", "cf-connecting-ip": `203.0.114.${i}` },
      });
      if (response.webSocket) {
        response.webSocket.accept();
        response.webSocket.close();
      }
      refused = response.status === 429;
    }
    expect(refused).toBe(true);
  });

  it("returns a cooldown when storage quota is exhausted", async () => {
    const bindings = { ...env, ROOM: { getByName: () => ({ fetch: async () => { throw new Error("Exceeded allowed rows written in Durable Objects free tier."); } }) } } as unknown as Env;
    const response = await worker.fetch(new Request("http://example.com/r/5557-acid-acorn-acre/"), bindings);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("relay_quota");
    expect(response.headers.get("retry-after")).toBe("300");
  });

  it("accepts only one host when two handshakes arrive together", async () => {
    const code = "5561-acid-acorn-acre";
    const stub = env.ROOM.getByName(await roomIdFromCode(code));
    const requests = Array.from({ length: 2 }, () => new Request(`http://example.com/host/${code}`, {
      headers: { upgrade: "websocket", "x-agenthop-kind": "host", "x-agenthop-code": code },
    }));
    const responses = await Promise.all(requests.map((request) => stub.fetch(request)));
    const clients = responses.map((response) => response.webSocket!);
    const messages = clients.map((client) => {
      const reply = new Promise<string>((resolve) => client.addEventListener("message", (event) => resolve(JSON.parse(event.data).type), { once: true }));
      client.accept();
      try { client.send(JSON.stringify({ v: 1, type: "open", code, token: "same-owner" })); } catch { /* Already rejected. */ }
      return reply;
    });
    try { expect((await Promise.all(messages)).sort()).toEqual(["error", "ready"]); }
    finally { for (const client of clients) client.close(); }
  });

  it("keeps the same alarm through repeated frames and reads activity from the socket", async () => {
    const code = "5558-acid-acorn-acre";
    const stub = env.ROOM.getByName(await roomIdFromCode(code));
    const client = await host(stub, code);
    try {
      await runInDurableObject(stub, async (instance, state) => {
        const room = instance as Room;
        await state.storage.deleteAlarm();
        await room.alarm();
        const scheduled = await state.storage.getAlarm();
        expect(scheduled).toBeGreaterThan(Date.now() + IDLE_MS - 1000);
        const socket = state.getWebSockets()[0]!;
        const frame = encodeFrame({ type: "abort", requestId: 999, reason: "test" });
        for (let i = 0; i < 20; i++) await room.webSocketMessage(socket, frame.slice().buffer as ArrayBuffer);
        expect(await state.storage.getAlarm()).toBe(scheduled);
        const attachment = socket.deserializeAttachment();
        socket.serializeAttachment({ ...attachment, activityAt: Date.now() - IDLE_MS - 1 });
        await state.storage.deleteAlarm();
        await room.alarm();
        expect(await state.storage.getAlarm()).toBeNull();
        expect(state.storage.sql.exec("SELECT * FROM meta").toArray()).toEqual([]);
      });
    } finally { client.close(); }
  });

  it("closes sockets that never finish the opening handshake", async () => {
    const code = "5559-acid-acorn-acre";
    const stub = env.ROOM.getByName(await roomIdFromCode(code));
    const response = await stub.fetch(new Request(`http://example.com/host/${code}`, { headers: { upgrade: "websocket", "x-agenthop-kind": "host", "x-agenthop-code": code } }));
    const client = response.webSocket!;
    client.accept();
    const closed = new Promise<CloseEvent>((resolve) => client.addEventListener("close", resolve, { once: true }));
    await runInDurableObject(stub, async (instance, state) => {
      const socket = state.getWebSockets()[0]!;
      socket.serializeAttachment({ ...socket.deserializeAttachment(), openedAt: Date.now() - 30_000 });
      await state.storage.deleteAlarm();
      await (instance as Room).alarm();
    });
    expect((await closed).code).toBe(1008);
    client.close();
  });

  it("keeps a disconnected pre-upgrade host's claim through an incomplete handshake", async () => {
    const code = "5560-acid-acorn-acre";
    const stub = env.ROOM.getByName(await roomIdFromCode(code));
    const until = Date.now() + IDLE_MS;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('host', 'owner-digest')");
      await state.storage.setAlarm(until);
    });
    const response = await stub.fetch(new Request(`http://example.com/host/${code}`, { headers: { upgrade: "websocket", "x-agenthop-kind": "host", "x-agenthop-code": code } }));
    const client = response.webSocket!;
    client.accept();
    await runInDurableObject(stub, async (instance, state) => {
      const socket = state.getWebSockets()[0]!;
      socket.serializeAttachment({ ...socket.deserializeAttachment(), openedAt: Date.now() - 30_000 });
      await state.storage.deleteAlarm();
      await (instance as Room).alarm();
      expect(await state.storage.getAlarm()).toBe(until);
      expect(state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'host'").one().v).toBe("owner-digest");
    });
    client.close();
  });

  it("forgets which host held a room once the room is over", async () => {
    // A code that comes round again must be free to open. Keeping the claim past the room
    // would lock a later host out of a room it opened itself, with a token nobody has.
    const code = "3333-acid-acorn-acre";
    const stub = env.ROOM.getByName(await roomIdFromCode(code));

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
      state.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('host', 'a-digest-from-the-last-room')");
    });
    await runInDurableObject(stub, (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());

    const left = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ k: string }>("SELECT k FROM meta WHERE k = 'host'").toArray(),
    );
    expect(left).toEqual([]);
  });
});

async function host(stub: DurableObjectStub, code: string): Promise<WebSocket> {
  const response = await stub.fetch(new Request(`http://example.com/host/${code}`, {
    headers: { upgrade: "websocket", "x-agenthop-kind": "host", "x-agenthop-code": code, "x-agenthop-public-base": `http://example.com/r/${code}/` },
  }));
  const client = response.webSocket!;
  client.accept();
  const ready = new Promise<MessageEvent>((resolve) => client.addEventListener("message", resolve, { once: true }));
  client.send(JSON.stringify({ v: 1, type: "open", code, token: "owner-token" }));
  expect(JSON.parse((await ready).data).type).toBe("ready");
  return client;
}
