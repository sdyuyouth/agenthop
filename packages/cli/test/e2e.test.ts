import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { readQueue, roomBase, sendMessage } from "../src/send.js";
import { startHost, type RunningHost } from "../src/host.js";
import { type SessionEvent } from "../src/talk.js";

const relays: RunningRelay[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("room over the relay", () => {
  it("carries messages both ways, in order, and stores what came with them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const home = path.join(dir, "home");
    const attached = path.join(dir, "notes.txt");
    await writeFile(attached, "from the other side");
    const relay = await startRelay();
    relays.push(relay);
    const events: SessionEvent[] = [];
    const host = await startHost({ relay: relay.url, home, keepFiles: true, onEvent: (event) => events.push(event) });
    hosts.push(host);

    for (const text of ["one", "two", "three"]) {
      await sendMessage({ code: host.code, text, relay: relay.url });
    }
    const withFile = await sendMessage({ code: host.code, text: "四", files: [attached], relay: relay.url });
    expect(withFile.from).toBe("peer");
    expect(await readFile(withFile.files[0]!.path, "utf8")).toBe("from the other side");
    expect(await readFile(path.join(home, "inbox", withFile.id, "notes.txt"), "utf8")).toBe("from the other side");

    const sent = await fetch(`${host.controlUrl}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "local-1", text: "back" }),
    });
    expect(sent.status).toBe(200);

    expect(events.map((event) => [event.from, event.text])).toEqual([
      ["peer", "one"],
      ["peer", "two"],
      ["peer", "three"],
      ["peer", "四"],
      ["host", "back"],
    ]);

    const seen = await readQueue(roomBase(relay.url, host.code.toUpperCase()));
    expect(seen.events.map((event) => event.text)).toEqual(["one", "two", "three", "四", "back"]);
    expect((await readQueue(roomBase(relay.url, host.code), 4)).events.map((event) => event.text)).toEqual(["back"]);
  });

  it("keeps the names of attachments but not the bytes unless asked to", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const home = path.join(dir, "home");
    const attached = path.join(dir, "notes.txt");
    await writeFile(attached, "please do not write me down");
    const relay = await startRelay();
    relays.push(relay);
    const host = await startHost({ relay: relay.url, home, onEvent: () => undefined });
    hosts.push(host);

    const sent = await sendMessage({ code: host.code, text: "带附件", files: [attached], relay: relay.url });
    expect(sent.files.map((file) => file.name)).toEqual(["notes.txt"]);
    expect(sent.files[0]!.path).toBe("");
    expect(existsSync(path.join(home, "inbox"))).toBe(false);
  });

  it("fails clearly when the room is not there", async () => {
    const relay = await startRelay();
    relays.push(relay);
    await expect(sendMessage({ code: "1111-acid-acorn-acre", text: "hi", relay: relay.url })).rejects.toThrow();
  });
});
