import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { sendMessage } from "../src/send.js";
import { startHost, type RunningHost } from "../src/host.js";

const relays: RunningRelay[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("agenthop host and send", () => {
  it("reads NOTES.md through a short code", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "agenthop-e2e-"));
    const root = path.join(parent, "notes");
    await mkdir(root);
    await writeFile(path.join(root, "NOTES.md"), "interface decision: keep JSON-RPC\n");
    const relay = await startRelay();
    relays.push(relay);
    const host = await startHost({ dir: root, relay: relay.url });
    hosts.push(host);
    expect(host.url.startsWith(relay.url)).toBe(true);

    const reply = await sendMessage({
      code: host.code,
      text: "NOTES.md 里关于接口的决定是什么",
      relay: relay.url,
    });
    expect(reply).toContain("keep JSON-RPC");

    const streamed = await sendMessage({
      code: host.code,
      text: "NOTES.md 里关于接口的决定是什么",
      relay: relay.url,
      stream: true,
    });
    expect(streamed.indexOf("interface")).toBeGreaterThanOrEqual(0);
    expect(streamed.indexOf("interface")).toBeLessThan(streamed.indexOf("JSON-RPC"));

    await host.close();
    hosts.pop();
    expect((await fetch(`${host.url}/`)).status).toBe(404);
  });

  it("echoes when no directory is shared", async () => {
    const relay = await startRelay();
    relays.push(relay);
    const host = await startHost({ relay: relay.url });
    hosts.push(host);
    const reply = await sendMessage({ code: host.code, text: "ping", relay: relay.url });
    expect(reply).toContain("ping");
  });
});
