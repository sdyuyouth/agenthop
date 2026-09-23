import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { PostCounter } from "@agenthop/tunnel";
import { sendMessage } from "../src/send.js";
import { startHost, type RunningHost } from "../src/host.js";

const relays: RunningRelay[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("what the room refuses", () => {
  it("keeps a stranger's attachment off the disk, not just out of the conversation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-limits-"));
    const home = path.join(dir, "home");
    const payload = path.join(dir, "payload.bin");
    await writeFile(payload, Buffer.alloc(40 * 1024, 1));
    const relay = await startRelay();
    relays.push(relay);
    const refusals: string[] = [];
    const host = await startHost({
      relay: relay.url,
      home,
      keepFiles: true,
      accept: (text) => text.includes("mine"),
      onRefused: (reason) => refusals.push(reason),
    });
    hosts.push(host);

    for (let i = 0; i < 5; i++) {
      await sendMessage({ code: host.code, text: "theirs", files: [payload], relay: relay.url });
    }
    expect(refusals).toHaveLength(5);
    expect(existsSync(path.join(home, "inbox"))).toBe(false);

    await sendMessage({ code: host.code, text: "mine", files: [payload], relay: relay.url });
    expect(await readdir(path.join(home, "inbox"))).toHaveLength(1);
  });

  it("stops accepting once the conversation has spent its allowance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-limits-"));
    const relay = await startRelay();
    relays.push(relay);
    const refusals: string[] = [];
    const host = await startHost({
      relay: relay.url,
      home: path.join(dir, "home"),
      limits: { messages: 3, textBytes: 32 },
      onRefused: (reason) => refusals.push(reason),
    });
    hosts.push(host);

    await sendMessage({ code: host.code, text: "一", relay: relay.url });
    await sendMessage({ code: host.code, text: "二", relay: relay.url });
    await sendMessage({ code: host.code, text: "三", relay: relay.url });
    await sendMessage({ code: host.code, text: "四", relay: relay.url });
    expect(refusals.join(" ")).toContain("消息条数已经到上限");

    const long = await startHost({
      relay: relay.url,
      home: path.join(dir, "home2"),
      limits: { textBytes: 16 },
      onRefused: (reason) => refusals.push(reason),
    });
    hosts.push(long);
    await sendMessage({ code: long.code, text: "x".repeat(64), relay: relay.url });
    expect(refusals.join(" ")).toContain("正文超过");
  });

  it("counts posts into one room per minute, and does not count reads", () => {
    const posts = new PostCounter();
    const now = Date.now();
    for (let i = 0; i < 60; i++) expect(posts.allow(now, 60)).toBe(true);
    expect(posts.allow(now, 60)).toBe(false);
    expect(posts.allow(now + 60_000, 60)).toBe(true);
  });
});
