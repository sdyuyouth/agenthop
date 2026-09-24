import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { startRelay } from "@agenthop/relay-node";
import { startHost } from "../src/host.js";
import { sendMessage } from "../src/send.js";
import { lineQueue, runSession, sessionPath } from "../src/session.js";

/**
 * A session that dies early leaves nothing in the log, and waiting for a line it will never
 * write reports a timeout instead of the reason. Keep the reason.
 */
let failures: unknown[] = [];

beforeEach(() => {
  failures = [];
});

function start(options: Parameters<typeof runSession>[0]): Promise<void> {
  return runSession(options).catch((error) => {
    failures.push(error);
  });
}

describe("session", () => {
  it("opens the channel when the joining agent writes a confirmation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const stop = new AbortController();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({
      hello: "我需要向对方了解鲁越森",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
      signal: stop.signal,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({
      code: code.toUpperCase(),
      lines: joinerLines,
      relay: relay.url,
      home: path.join(dir, "joiner"),
      signal: stop.signal,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello 我需要向对方了解鲁越森");
    joinerLines.push("确认建立通道");
    await waitForText(path.join(dir, "creator"), "ready");
    joinerLines.push("近况如何");
    await waitForText(path.join(dir, "creator"), "peer say 近况如何");
    creatorLines.push("下一句");
    await waitForText(path.join(dir, "creator"), "local say 下一句");
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), code, "create"), "utf8");
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
    const creator = start({
      hello: "我需要向对方了解鲁越森",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
      signal: stop.signal,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({
      code,
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "joiner"),
      signal: stop.signal,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    await delay(400);
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), code, "create"), "utf8");
    expect(creatorLog).not.toContain("ready");
    expect(creatorLog).not.toContain("confirm");
    stop.abort();
    await Promise.allSettled([creator, joiner, relay.close()]);
  });

  it("says goodbye back before either side goes", async () => {
    for (const opener of ["creator", "joiner"] as const) {
      const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
      const relay = await startRelay();
      const creatorLines = lineQueue();
      const joinerLines = lineQueue();
      const creator = start({
        hello: "背景",
        lines: creatorLines,
        relay: relay.url,
        home: path.join(dir, "creator"),
      });
      const code = await waitForText(path.join(dir, "creator"), "waiting");
      const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
      await waitForText(path.join(dir, "joiner"), "peer hello");
      joinerLines.push("确认");
      await waitForText(path.join(dir, "creator"), "ready");

      (opener === "creator" ? creatorLines : joinerLines).push("/bye");
      await Promise.all([creator, joiner]);

      for (const side of ["creator", "joiner"] as const) {
        const log = await readFile(sessionPath(path.join(dir, side), code, side === "creator" ? "create" : "join"), "utf8");
        expect(log, `${side} log when ${opener} opened the goodbye`).toContain("local bye");
        expect(log, `${side} log when ${opener} opened the goodbye`).toContain("peer bye");
      }
      const openerLog = await readFile(sessionPath(path.join(dir, opener), code, opener === "creator" ? "create" : "join"), "utf8");
      expect(openerLog.indexOf("local bye")).toBeLessThan(openerLog.indexOf("peer bye"));
      await relay.close();
    }
  });

  it("leaves after saying goodbye when the other side never says it back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const creator = start({
      hello: "背景",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
      byeWaitMs: 500,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    // A peer that connects and confirms but never reads the room again.
    await sendMessage({ code, text: "[[agenthop:connect]]", relay: relay.url });
    await waitForText(path.join(dir, "creator"), "local hello");
    await sendMessage({ code, text: "[[agenthop:confirm]] 确认", relay: relay.url });
    await waitForText(path.join(dir, "creator"), "ready");

    creatorLines.push("/bye");
    await creator;
    const log = await readFile(sessionPath(path.join(dir, "creator"), code, "create"), "utf8");
    expect(log).toContain("local bye");
    expect(log).toContain("peer gone 对方没有把告别说回来");
    await relay.close();
  });

  it("writes peer gone instead of a raw relay error when the room disappears", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creator = start({
      hello: "背景",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
      recoverMs: 300,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({
      code,
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "joiner"),
      recoverMs: 300,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello");

    await relay.close();
    await waitForText(path.join(dir, "joiner"), "peer gone");
    await waitForText(path.join(dir, "creator"), "peer gone");
    await Promise.all([creator, joiner]);
  });

  it("calls the room expired, not the peer gone, when nobody ever joined", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creator = start({
      hello: "背景",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
      recoverMs: 300,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    await relay.close();
    await waitForText(path.join(dir, "creator"), "local expired");
    await creator;
    const log = await readFile(sessionPath(path.join(dir, "creator"), code, "create"), "utf8");
    expect(log).not.toContain("peer gone");
    expect(log).toContain("配对码");
  });

  it("writes down what it could not send instead of losing it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const joinerLines = lineQueue();
    const creator = start({
      hello: "背景",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
      recoverMs: 300,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({
      code,
      lines: joinerLines,
      relay: relay.url,
      home: path.join(dir, "joiner"),
      recoverMs: 300,
    });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    await relay.close();
    joinerLines.push("这句发不出去了");
    await waitForText(path.join(dir, "joiner"), "local undelivered 这句发不出去了");
    await Promise.all([creator, joiner]);
  });

  it("ignores a third person holding the same code", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const joinerLines = lineQueue();
    const creator = start({
      hello: "背景",
      lines: lineQueue(),
      relay: relay.url,
      home: path.join(dir, "creator"),
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    await sendMessage({ code, text: "[[agenthop:say:stranger]] 我是第三个人", relay: relay.url });
    await waitForText(path.join(dir, "creator"), "peer refused");
    const log = await readFile(sessionPath(path.join(dir, "creator"), code, "create"), "utf8");
    expect(log).not.toContain("peer say 我是第三个人");

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("puts the room back on the same code after the relay comes back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const port = 8399;
    let relay = await startRelay({ listenPort: port });
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({
      hello: "背景",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    await relay.close();
    await waitForText(path.join(dir, "creator"), "local reconnecting");
    relay = await startRelay({ listenPort: port });
    await waitForText(path.join(dir, "creator"), "local reconnected");

    creatorLines.push("断线之后的一句");
    await waitForText(path.join(dir, "joiner"), "peer say 断线之后的一句");
    creatorLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("says so when its own standard input is closed, and keeps listening", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({
      hello: "背景",
      lines: creatorLines,
      relay: relay.url,
      home: path.join(dir, "creator"),
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    creatorLines.end();
    await waitForText(path.join(dir, "creator"), "local input-closed");
    joinerLines.push("还在听吗");
    await waitForText(path.join(dir, "creator"), "peer say 还在听吗");

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("gives each end of a conversation its own log, even on one machine", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const home = path.join(dir, "shared");
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    // Both sides run as the same person here, which is what put them in one file before.
    const creator = start({ hello: "背景", lines: creatorLines, relay: relay.url, home });
    const code = await waitForText(home, "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home });
    await waitForText(home, "peer hello");
    joinerLines.push("确认");
    await waitForText(home, "local ready");
    creatorLines.push("一句话");
    await waitForText(home, "peer say 一句话");

    const mine = await readFile(sessionPath(home, code, "create"), "utf8");
    const theirs = await readFile(sessionPath(home, code, "join"), "utf8");
    expect(mine).toContain("local waiting");
    expect(mine).toContain("local say 一句话");
    expect(mine).not.toContain("peer say 一句话");
    expect(theirs).toContain("peer say 一句话");
    expect(theirs).not.toContain("local waiting");
    // Each log opens by saying where it is.
    expect(mine.split("\n")[0]).toContain(`local log ${sessionPath(home, code, "create")}`);
    expect(theirs.split("\n")[0]).toContain(`local log ${sessionPath(home, code, "join")}`);

    creatorLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("says the room is taken at once, instead of waiting out the deadline", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const code = "1111-acid-acorn-acre";
    const held = await startHost({ relay: relay.url, code, home: path.join(dir, "held") });

    // The refusal arrives the moment the socket is accepted, before anything has been sent.
    const started = Date.now();
    await expect(startHost({ relay: relay.url, code, home: path.join(dir, "second") })).rejects.toThrow(/已经被另一个进程占着/);
    expect(Date.now() - started).toBeLessThan(5000);

    await held.close();
    await relay.close();
  });
});

async function waitForText(home: string, text: string): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (failures.length > 0) throw new Error(`session stopped: ${failures[0] instanceof Error ? failures[0].stack : failures[0]}`);
    let files: string[] = [];
    try {
      files = await readdir(path.join(home, "sessions"));
    } catch {
      files = [];
    }
    for (const file of files) {
      const body = await readFile(path.join(home, "sessions", file), "utf8");
      const line = body.split("\n").find((candidate) => candidate.includes(text));
      if (line) return file.replace(/\.(create|join)\.log$/, "");
    }
    await delay(50);
  }
  throw new Error(`${text} did not arrive in ${home}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}