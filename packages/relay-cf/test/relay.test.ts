import { SELF, env, runInDurableObject } from "cloudflare:test";
import { rateShard, roomIdFromCode } from "@agenthop/tunnel";
import { describe, expect, it } from "vitest";

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

  it("counts an address without keeping it", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 3; i++) {
      await SELF.fetch("http://example.com/r/5555-acid-acorn-acre/", { headers: { "cf-connecting-ip": ip } });
    }

    const stub = env.RATE_LIMIT.getByName(rateShard(ip));
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ k: string; window: number }>("SELECT k, window FROM counters").toArray(),
    );

    expect(rows.length).toBeGreaterThan(0);
    // The address itself is never written down, and only the current minute is kept.
    expect(rows.some((row) => row.k.includes(ip))).toBe(false);
    expect(new Set(rows.map((row) => row.window)).size).toBe(1);
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
