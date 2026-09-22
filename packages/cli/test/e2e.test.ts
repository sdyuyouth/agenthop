import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { sendMessage } from "../src/send.js";
import { type HostEvent } from "../src/desk.js";
import { startHost, type RunningHost } from "../src/host.js";

const relays: RunningRelay[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("question and result", () => {
  it("carries text and a file in both directions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const home = path.join(dir, "home");
    const asked = path.join(dir, "asked.txt");
    const answered = path.join(dir, "answered.txt");
    await writeFile(asked, "from the asker");
    await writeFile(answered, "from the answerer");
    const relay = await startRelay();
    relays.push(relay);
    const events: HostEvent[] = [];
    const host = await startHost({ relay: relay.url, home, onEvent: (event) => events.push(event) });
    hosts.push(host);

    const pending = sendMessage({
      code: host.code,
      text: "what did you decide",
      files: [asked],
      relay: relay.url,
      outDir: path.join(dir, "out"),
      waitMs: 5000,
    });

    const question = await waitForQuestion(host);
    expect(question.text).toBe("what did you decide");
    expect(await readFile(question.files[0]!.path, "utf8")).toBe("from the asker");
    expect(events).toEqual([
      { event: "received", id: question.id, text: "what did you decide", files: question.files },
    ]);

    const reply = await fetch(`${host.controlUrl}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: question.id, text: "keep JSON-RPC", files: [answered] }),
    });
    expect(reply.status).toBe(204);

    const result = await pending;
    expect(result.text).toBe("keep JSON-RPC");
    expect(await readFile(result.files[0]!.path, "utf8")).toBe("from the answerer");
    expect(events[1]).toMatchObject({ event: "sent", id: question.id, text: "keep JSON-RPC" });
    expect(events[1]!.files[0]!.path).toBe(answered);
    expect((await fetch(`${host.controlUrl}/inbox`)).status).toBe(200);
    expect(await (await fetch(`${host.controlUrl}/inbox`)).json()).toEqual([]);
  });
});

async function waitForQuestion(host: RunningHost) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await fetch(`${host.controlUrl}/inbox`);
    const inbox = (await response.json()) as { id: string; text: string; files: { path: string }[] }[];
    if (inbox.length > 0) return inbox[0]!;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("question did not arrive");
}
