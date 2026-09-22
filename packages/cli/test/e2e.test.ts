import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { sendMessage } from "../src/send.js";
import { startHost, type RunningHost } from "../src/host.js";
import { type SessionEvent } from "../src/talk.js";

const relays: RunningRelay[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("queue", () => {
  it("answers the current ask before later messages are delivered", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const home = path.join(dir, "home");
    const asked = path.join(dir, "asked.txt");
    const answered = path.join(dir, "answered.txt");
    await writeFile(asked, "from the asker");
    await writeFile(answered, "from the answerer");
    const relay = await startRelay();
    relays.push(relay);
    const events: SessionEvent[] = [];
    const host = await startHost({ relay: relay.url, home, onEvent: (event) => events.push(event) });
    hosts.push(host);

    const pending = sendMessage({
      code: host.code,
      kind: "ask",
      text: "what did you decide",
      files: [asked],
      relay: relay.url,
      outDir: path.join(dir, "out"),
      waitMs: 5000,
    });
    const current = await waitFor(events, (event) => event.event === "current");
    expect(current.text).toBe("what did you decide");
    expect(await readFile(current.files[0]!.path, "utf8")).toBe("from the asker");

    for (const text of ["one", "two", "three"]) {
      const queued = await sendMessage({ code: host.code, text, relay: relay.url });
      expect(queued.event).toBe("queued");
      expect(queued.current).toBe(current.id);
    }
    expect(events.filter((event) => event.event === "said")).toEqual([]);
    const supplement = await sendMessage({ code: host.code, kind: "supplement", text: "also tests", relay: relay.url });
    expect(supplement.event).toBe("supplement");
    expect(supplement.current).toBe(current.id);

    const reply = await fetch(`${host.controlUrl}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        kind: "result",
        answerId: current.id,
        text: "keep JSON-RPC",
        files: [answered],
      }),
    });
    expect(reply.status).toBe(200);
    const result = await pending;
    expect(result.text).toBe("keep JSON-RPC");
    expect(await readFile(result.files[0]!.path, "utf8")).toBe("from the answerer");
    expect(events.filter((event) => event.event === "said").map((event) => event.text)).toEqual(["one", "two", "three"]);
    expect(events.some((event) => event.event === "done" && event.id === current.id)).toBe(true);
  });

  it("lets the peer answer the current ask", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const relay = await startRelay();
    relays.push(relay);
    const events: SessionEvent[] = [];
    const host = await startHost({ relay: relay.url, home: path.join(dir, "home"), onEvent: (event) => events.push(event) });
    hosts.push(host);
    const pending = sendMessage({ code: host.code, kind: "ask", text: "question", relay: relay.url, waitMs: 5000 });
    const current = await waitFor(events, (event) => event.event === "current");
    const answered = await sendMessage({
      code: host.code,
      kind: "result",
      answerId: current.id,
      text: "from peer",
      relay: relay.url,
    });
    expect(answered.event).toBe("done");
    expect(answered.id).toBe(current.id);
    expect((await pending).text).toBe("from peer");
  });

  it("replies with the command output when a peer message reaches the head", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const relay = await startRelay();
    relays.push(relay);
    const events: SessionEvent[] = [];
    const host = await startHost({
      relay: relay.url,
      home: path.join(dir, "home"),
      onReceive: echoText,
      onEvent: (event) => events.push(event),
    });
    hosts.push(host);

    await sendMessage({ code: host.code, text: "ping", relay: relay.url });
    const reply = await waitFor(events, (event) => event.from === "host" && event.event === "said");
    expect(reply.text).toBe("ping");

    const asked = sendMessage({ code: host.code, kind: "ask", text: "pong", relay: relay.url, waitMs: 5000 });
    expect((await asked).text).toBe("pong");
  });

  it("leaves the ask unanswered when the command fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const relay = await startRelay();
    relays.push(relay);
    const events: SessionEvent[] = [];
    const host = await startHost({
      relay: relay.url,
      home: path.join(dir, "home"),
      onReceive: "node -e \"process.exit(1)\"",
      onEvent: (event) => events.push(event),
    });
    hosts.push(host);
    await expect(
      sendMessage({ code: host.code, kind: "ask", text: "stay", relay: relay.url, waitMs: 700 }),
    ).rejects.toThrow(/no result/);
    expect(events.some((event) => event.event === "current")).toBe(true);
    expect(events.some((event) => event.event === "done")).toBe(false);
  });
});

const echoText = `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).text))"`;

async function waitFor(events: SessionEvent[], ready: (event: SessionEvent) => boolean): Promise<SessionEvent> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = events.find(ready);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("event did not arrive");
}
