import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRelay } from "@agenthop/relay-node";
import { startHost } from "../src/host.js";
import { readQueue, roomBase, sendMessage } from "../src/send.js";
import { addressOf } from "@agenthop/tunnel";
import { channel } from "../src/seal.js";
import { lineQueue, sessionPath } from "../src/session.js";
import { delay, failures, resetFailures, start, waitForText } from "./harness.js";

beforeEach(() => {
  resetFailures();
});

// A session that ends by throwing has lost whatever it was holding, whatever the log says after.
afterEach(() => {
  expect(failures.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([]);
});

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
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), addressOf(code), "create"), "utf8");
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
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), addressOf(code), "create"), "utf8");
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
        const log = await readFile(sessionPath(path.join(dir, side), addressOf(code), side === "creator" ? "create" : "join"), "utf8");
        expect(log, `${side} log when ${opener} opened the goodbye`).toContain("local bye");
        expect(log, `${side} log when ${opener} opened the goodbye`).toContain("peer bye");
      }
      const openerLog = await readFile(sessionPath(path.join(dir, opener), addressOf(code), opener === "creator" ? "create" : "join"), "utf8");
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
    // A peer that connects and confirms but never reads the room again. It holds the secret, so
    // one channel for both lines: a second channel would restart the counter and look replayed.
    const peer = channel(code, "join");
    await sendMessage({ code: addressOf(code), text: peer.seal("[[agenthop:connect:abc123]]"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "local hello");
    await sendMessage({ code: addressOf(code), text: peer.seal("[[agenthop:confirm:abc123]] 确认"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "ready");

    creatorLines.push("/bye");
    await creator;
    const log = await readFile(sessionPath(path.join(dir, "creator"), addressOf(code), "create"), "utf8");
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
    const log = await readFile(sessionPath(path.join(dir, "creator"), addressOf(code), "create"), "utf8");
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

    const address = addressOf(code);
    // Someone who only knows the room address, and so cannot seal anything. They are told they
    // were turned away rather than left believing they had spoken.
    await expect(
      sendMessage({ code: address, text: "[[agenthop:say:stranger]] 我是第三个人", relay: relay.url }),
    ).rejects.toThrow(/密钥/);
    // And someone who guessed a secret for the same address, which reads no better.
    const guesser = channel(`${address}-aaaaaaaaaaaaaaaaaaaaaaaaaa`, "join");
    await expect(
      sendMessage({ code: address, text: guesser.seal("[[agenthop:say:stranger]] 我也是"), relay: relay.url }),
    ).rejects.toThrow(/密钥/);
    await waitForText(path.join(dir, "creator"), "peer refused");
    const log = await readFile(sessionPath(path.join(dir, "creator"), address, "create"), "utf8");
    expect(log).not.toContain("peer say 我是第三个人");
    expect(log).not.toContain("peer say 我也是");

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

  it("carries a receipt under its own state word, both ways", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({ hello: "背景", lines: creatorLines, relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    // The receipt reaches the other side as `working`, never as `say` — the word the waiting
    // side keys on to decide it is their turn.
    joinerLines.push("/working 收到，我去查这三个文件，大概两三分钟");
    await waitForText(path.join(dir, "creator"), "peer working 收到，我去查这三个文件，大概两三分钟");
    creatorLines.push("/working 我这边也在准备材料");
    await waitForText(path.join(dir, "joiner"), "peer working 我这边也在准备材料");
    joinerLines.push("查完了");
    await waitForText(path.join(dir, "creator"), "peer say 查完了");

    const log = await readFile(sessionPath(path.join(dir, "creator"), addressOf(code), "create"), "utf8");
    expect(log).toContain("local working 我这边也在准备材料");
    expect(log).not.toContain("peer say 收到，我去查");
    // A receipt does not move the conversation along, and it is not the goodbye either.
    expect(log).not.toContain("peer refused");
    expect(log.indexOf("peer working")).toBeLessThan(log.indexOf("peer say 查完了"));

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("sends a receipt written before the channel opens without eating the confirmation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const joinerLines = lineQueue();
    const creator = start({ hello: "背景", lines: lineQueue(), relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");

    // An agent that writes a receipt first should not find it spent as the confirmation.
    joinerLines.push("/working 收到背景，正在核对");
    joinerLines.push("核对上了，可以开始");
    await waitForText(path.join(dir, "creator"), "peer working 收到背景，正在核对");
    await waitForText(path.join(dir, "creator"), "peer confirm 核对上了，可以开始");
    await waitForText(path.join(dir, "creator"), "local ready");

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("writes down a form it does not know instead of turning the peer away", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creator = start({ hello: "背景", lines: lineQueue(), relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const address = addressOf(code);

    // A peer holding the secret, speaking a form some later version added.
    const peer = channel(code, "join");
    await sendMessage({ code: address, text: peer.seal("[[agenthop:connect:abc123]]"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "local hello");
    await sendMessage({ code: address, text: peer.seal("[[agenthop:futureform:abc123]] 来自更新的版本"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "peer other");

    const log = await readFile(sessionPath(path.join(dir, "creator"), address, "create"), "utf8");
    expect(log).not.toContain("peer refused");
    // The whole line is kept, so the log says which form it was.
    expect(log).toContain("peer other [[agenthop:futureform:abc123]] 来自更新的版本");

    await sendMessage({ code: address, text: peer.seal("[[agenthop:bye:abc123]]"), relay: relay.url });
    await Promise.all([creator]);
    await relay.close();
  });

  it("hands the room's history to nobody who lacks the key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({ hello: "我需要向对方了解鲁越森", lines: creatorLines, relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认建立通道");
    await waitForText(path.join(dir, "creator"), "ready");
    creatorLines.push("这一句是机密");
    await waitForText(path.join(dir, "joiner"), "peer say 这一句是机密");

    // The whole history, read the way anyone holding the address could read it.
    const queue = await readQueue(roomBase(relay.url, addressOf(code)));
    expect(queue.events.length).toBeGreaterThan(2);
    for (const event of queue.events) expect(event.text.startsWith("[[agenthop:sealed]] ")).toBe(true);
    const everything = queue.events.map((event) => event.text).join("\n");
    expect(everything).not.toContain("我需要向对方了解鲁越森");
    expect(everything).not.toContain("确认建立通道");
    expect(everything).not.toContain("这一句是机密");
    expect(everything).not.toContain("[[agenthop:say");

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("refuses a line the relay hands over a second time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({ hello: "背景", lines: creatorLines, relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");
    joinerLines.push("确认，可以");
    await waitForText(path.join(dir, "creator"), "peer say 确认，可以");

    // Take the joiner's own sealed line off the room and play it back, the way a relay could.
    const queue = await readQueue(roomBase(relay.url, addressOf(code)));
    const replayed = queue.events.filter((event) => event.from === "peer").at(-1)!.text;
    await sendMessage({ code: addressOf(code), text: replayed, relay: relay.url });
    await waitForText(path.join(dir, "creator"), "peer refused 重复的消息");

    joinerLines.push("/bye");
    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("still says goodbye when the joining side is interrupted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const joinerLines = lineQueue();
    const stop = new AbortController();
    const creator = start({ hello: "背景", lines: lineQueue(), relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner"), signal: stop.signal });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    // Ctrl-C on the joining side. Its goodbye is signed like every other line it sends, so the
    // creator takes it instead of sitting out the clock waiting for one.
    stop.abort();
    await waitForText(path.join(dir, "creator"), "peer bye");
    const log = await readFile(sessionPath(path.join(dir, "creator"), addressOf(code), "create"), "utf8");
    expect(log).not.toContain("peer refused");
    expect(log).not.toContain("peer gone");

    await Promise.all([creator, joiner]);
    await relay.close();
  });

  it("carries a line right up to the documented size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const creatorLines = lineQueue();
    const joinerLines = lineQueue();
    const creator = start({ hello: "背景", lines: creatorLines, relay: relay.url, home: path.join(dir, "creator") });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = start({ code, lines: joinerLines, relay: relay.url, home: path.join(dir, "joiner") });
    await waitForText(path.join(dir, "joiner"), "peer hello");
    joinerLines.push("确认");
    await waitForText(path.join(dir, "creator"), "ready");

    // 64 KiB is what the help text promises. Sealed it is about 87 KiB, which is what the room
    // actually measures — the two numbers have to stay far enough apart.
    const long = "x".repeat(64 * 1024);
    joinerLines.push(long);
    await waitForText(path.join(dir, "creator"), `peer say ${long}`);

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

    const mine = await readFile(sessionPath(home, addressOf(code), "create"), "utf8");
    const theirs = await readFile(sessionPath(home, addressOf(code), "join"), "utf8");
    expect(mine).toContain("local waiting");
    expect(mine).toContain("local say 一句话");
    expect(mine).not.toContain("peer say 一句话");
    expect(theirs).toContain("peer say 一句话");
    expect(theirs).not.toContain("local waiting");
    // Each log opens by saying where it is.
    expect(mine.split("\n")[0]).toContain(`local log ${sessionPath(home, addressOf(code), "create")}`);
    expect(theirs.split("\n")[0]).toContain(`local log ${sessionPath(home, addressOf(code), "join")}`);

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
