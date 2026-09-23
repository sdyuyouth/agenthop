import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startRelay } from "@agenthop/relay-node";
import { sendMessage } from "../src/send.js";
import { lineQueue, runSession, sayWire, sessionPath } from "../src/session.js";

describe("session", () => {
  it("opens the channel when the joining agent writes a confirmation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const stop = new AbortController();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = runSession({
      hello: "我需要向对方了解鲁越森",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
      signal: stop.signal,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({
      code: code.toUpperCase(),
      lines: joinerLines,
      relay: relay.url,
      home: path.join(dir, "joiner"),
      signal: stop.signal,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello 我需要向对方了解鲁越森");
    joinerLines.push("确认建立通道");
    await waitForText(path.join(dir, "creator"), "ready");
    await sendMessage({ code, text: sayWire("近况如何"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "peer say 近况如何");
    creatorLines.push("下一句");
    await waitForText(path.join(dir, "creator"), "local say 下一句");
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), code), "utf8");
    expect(creatorLog).toContain("peer connected");
    expect(creatorLog).not.toContain("local connected");
    expect(creatorLog).toContain("peer confirm 确认建立通道");
    expect(creatorLog.indexOf("local ready")).toBeLessThan(creatorLog.indexOf("peer say 近况如何"));
    stop.abort();
    await Promise.allSettled([creator, joiner, relay.close()]);
  });

  it("stays unready when the joining agent writes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const stop = new AbortController();
    const creator = runSession({
      hello: "我需要向对方了解鲁越森",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
      signal: stop.signal,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({
      code,
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "joiner"),
      signal: stop.signal,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    await delay(400);
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), code), "utf8");
    expect(creatorLog).not.toContain("ready");
    expect(creatorLog).not.toContain("confirm");
    stop.abort();
    await Promise.allSettled([creator, joiner, relay.close()]);
  });

  it("ends both sides when one of them says goodbye", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = runSession({
      hello: "背景",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    creatorLines.push("/bye");
    await waitForText(path.join(dir, "joiner"), "peer bye");
    await Promise.all([creator, joiner]);
    expect(await readFile(sessionPath(path.join(dir, "creator"), code), "utf8")).toContain("local bye");
    await relay.close();
  });

  it("writes peer gone instead of a raw relay error when the room disappears", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creator = runSession({
      hello: "背景",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({
      code,
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "joiner"),
      goneAfterMs: 300,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello");

    await relay.close();
    await waitForText(path.join(dir, "joiner"), "peer gone");
    await waitForText(path.join(dir, "creator"), "peer gone");
    await Promise.all([creator, joiner]);
  });

  it("says so when its own standard input is closed, and keeps listening", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = runSession({
      hello: "背景",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    creatorLines.end();
    await waitForText(path.join(dir, "creator"), "local input-closed");
    await sendMessage({ code, text: sayWire("还在听吗"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "peer say 还在听吗");

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });
});

async function waitForText(home: string, text: string): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try {
      files = await readdir(path.join(home, "sessions"));
    } catch {
      files = [];
    }
    for (const file of files) {
      const body = await readFile(path.join(home, "sessions", file), "utf8");
      const line = body.split("\n").find((candidate) => candidate.includes(text));
      if (line) return file.replace(/\.log$/, "");
    }
    await delay(50);
  }
  throw new Error(`${text} did not arrive in ${home}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
