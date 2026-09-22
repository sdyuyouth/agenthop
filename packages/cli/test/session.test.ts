import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startRelay } from "@agenthop/relay-node";
import { sendMessage } from "../src/send.js";
import { runSession, sayWire, sessionPath } from "../src/session.js";

const confirmAgent = `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(s.includes(' hello ')) process.stdout.write('确认建立通道'); else if(s.includes(' say ')) process.stdout.write('收到')})"`;
const replyAgent = `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(s.includes(' say ')) process.stdout.write('下一句')})"`;
const refuseAgent = `node -e "process.exit(1)"`;

describe("session", () => {
  it("opens the channel only after the joining agent confirms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const stop = new AbortController();
    const creator = runSession({
      hello: "我需要向对方了解鲁越森",
      agent: replyAgent,
      relay: relay.url,
      home: path.join(dir, "creator"),
      signal: stop.signal,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({
      code,
      agent: confirmAgent,
      relay: relay.url,
      home: path.join(dir, "joiner"),
      signal: stop.signal,
    });
    await waitForText(path.join(dir, "creator"), "ready");
    await waitForText(path.join(dir, "joiner"), "peer hello 我需要向对方了解鲁越森");
    await sendMessage({ code, text: sayWire("近况如何"), relay: relay.url });
    await waitForText(path.join(dir, "creator"), "local say 下一句");
    const creatorLog = await readFile(sessionPath(path.join(dir, "creator"), code), "utf8");
    expect(creatorLog).toContain("local connected");
    expect(creatorLog).toContain("peer confirm 确认建立通道");
    expect(creatorLog.indexOf("local ready")).toBeLessThan(creatorLog.indexOf("peer say 近况如何"));
    stop.abort();
    await Promise.allSettled([creator, joiner, relay.close()]);
  });

  it("does not open the channel when the joining agent does not confirm", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-session-"));
    const relay = await startRelay();
    const stop = new AbortController();
    const creator = runSession({
      hello: "我需要向对方了解鲁越森",
      agent: replyAgent,
      relay: relay.url,
      home: path.join(dir, "creator"),
      signal: stop.signal,
    });
    const code = await waitForText(path.join(dir, "creator"), "waiting");
    const joiner = runSession({
      code,
      agent: refuseAgent,
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
});

async function waitForText(home: string, text: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { readdir, readFile } = await import("node:fs/promises");
    let files: string[] = [];
    try {
      files = await readdir(path.join(home, "sessions"));
    } catch {
      files = [];
    }
    for (const file of files) {
      const body = await readFile(path.join(home, "sessions", file), "utf8");
      if (body.includes(text)) {
        const code = body.match(/waiting (\S+)/)?.[1] ?? file.replace(/\.log$/, "");
        return code;
      }
    }
    await delay(30);
  }
  throw new Error(`log did not contain ${text}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
