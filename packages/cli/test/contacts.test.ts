import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { addressOf } from "@agenthop/tunnel";
import { fingerprint, loadIdentity, saveContact } from "../src/identity.js";
import { deliverInvitation, startInbox, type Inbox, type Received } from "../src/inbox.js";
import { sealInvitation } from "../src/invite.js";
import { startMcpServer } from "../src/mcp.js";
import { sendMessage } from "../src/send.js";
import { inboxAddress } from "../src/identity.js";
import { lineQueue, runSession, sessionPath } from "../src/session.js";
import { delay, failures, pair, resetFailures, start, waitForText } from "./harness.js";

const relays: RunningRelay[] = [];
const inboxes: Inbox[] = [];
const closers: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  resetFailures();
});

afterEach(async () => {
  expect(failures.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([]);
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  await Promise.allSettled(inboxes.splice(0).map((inbox) => inbox.close()));
  await Promise.allSettled(relays.splice(0).map((relay) => relay.close()));
});

async function relay(): Promise<string> {
  const running = await startRelay();
  relays.push(running);
  return running.url;
}

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agenthop-contacts-"));
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(50);
  }
}

describe("identity inside a conversation", () => {
  it("each side learns who the other is, before the hello", async () => {
    const url = await relay();
    const base = await dir();
    const stop = new AbortController();
    const conversation = await pair(url, base, { creator: { signal: stop.signal }, joiner: { signal: stop.signal } });
    const creatorKey = loadIdentity(conversation.creatorHome).publicKey;
    const joinerKey = loadIdentity(conversation.joinerHome).publicKey;
    const creatorLog = await conversation.log("creator");
    const joinerLog = await conversation.log("joiner");
    expect(creatorLog).toContain(`peer identity 不在联系人里，指纹 ${fingerprint(joinerKey)}`);
    expect(joinerLog).toContain(`peer identity 不在联系人里，指纹 ${fingerprint(creatorKey)}`);
    expect(joinerLog.indexOf("peer identity")).toBeLessThan(joinerLog.indexOf("peer hello"));
    expect(creatorLog).not.toContain("peer other");
    expect(joinerLog).not.toContain("peer other");
    stop.abort();
    await Promise.allSettled([conversation.creator, conversation.joiner]);
  });

  it("names a contact by the name it was saved under", async () => {
    const url = await relay();
    const base = await dir();
    const joinerKey = loadIdentity(path.join(base, "joiner")).publicKey;
    saveContact(path.join(base, "creator"), "bob", joinerKey);
    const stop = new AbortController();
    const conversation = await pair(url, base, { creator: { signal: stop.signal }, joiner: { signal: stop.signal } });
    expect(await conversation.log("creator")).toContain(`peer identity bob（联系人，指纹 ${fingerprint(joinerKey)}）`);
    stop.abort();
    await Promise.allSettled([conversation.creator, conversation.joiner]);
  });

  it("says nothing new to a side from before contacts, in either seat", async () => {
    const url = await relay();
    for (const old of ["creator", "joiner"] as const) {
      const base = await dir();
      const stop = new AbortController();
      const conversation = await pair(url, base, {
        creator: { signal: stop.signal, ...(old === "creator" ? { identity: false as const } : {}) },
        joiner: { signal: stop.signal, ...(old === "joiner" ? { identity: false as const } : {}) },
      });
      conversation.joinerLines.push("一句话");
      await waitForText(conversation.creatorHome, "peer say 一句话");
      // The old side is sent nothing it would not know; the new side is told no identity.
      const oldLog = await conversation.log(old);
      const newLog = await conversation.log(old === "creator" ? "joiner" : "creator");
      expect(oldLog, `${old} old`).not.toContain("peer other");
      expect(newLog, `${old} old`).not.toContain("peer identity");
      if (old === "joiner") expect(oldLog).not.toContain("peer identity");
      stop.abort();
      await Promise.allSettled([conversation.creator, conversation.joiner]);
    }
  });

  it("keeps a room opened for one contact from anyone else holding its code", async () => {
    const url = await relay();
    const base = await dir();
    const invitedHome = path.join(base, "invited");
    const intruderHome = path.join(base, "intruder");
    const creatorHome = path.join(base, "creator");
    const stop = new AbortController();
    const creator = start({ hello: "只给 bob", lines: lineQueue(), relay: url, home: creatorHome, signal: stop.signal, expectPeer: loadIdentity(invitedHome).publicKey });
    const code = await waitForText(creatorHome, "waiting");

    // Someone who got hold of the code, but is not the one it was meant for.
    await expect(runSession({ code, lines: lineQueue(), relay: url, home: intruderHome, signal: stop.signal })).rejects.toThrow(/不是被邀请的那个人/);
    const creatorLog = () => readFile(sessionPath(creatorHome, addressOf(code), "create"), "utf8");
    expect(await creatorLog()).toContain("peer refused 这个房间是为邀请开的");

    // The seat is still free for the right one.
    const joinerLines = lineQueue();
    const joiner = start({ code, lines: joinerLines, relay: url, home: invitedHome, signal: stop.signal });
    await waitForText(invitedHome, "peer hello 只给 bob");
    joinerLines.push("是我");
    await waitForText(creatorHome, "local ready");
    stop.abort();
    await Promise.allSettled([creator, joiner]);
  });

  it("leaves a room when whoever opened it is not who sent the invitation", async () => {
    const url = await relay();
    const base = await dir();
    const creatorHome = path.join(base, "creator");
    const joinerHome = path.join(base, "joiner");
    const expected = loadIdentity(path.join(base, "someone-else")).publicKey;
    const stop = new AbortController();
    const creator = start({ hello: "冒充的", lines: lineQueue(), relay: url, home: creatorHome, signal: stop.signal });
    const code = await waitForText(creatorHome, "waiting");
    await runSession({ code, lines: lineQueue(), relay: url, home: joinerHome, expectPeer: expected });
    const joinerLog = await readFile(sessionPath(joinerHome, addressOf(code), "join"), "utf8");
    expect(joinerLog).toContain("peer refused 开这个房间的不是发邀请的那个人");
    expect(joinerLog).not.toContain("peer hello");
    stop.abort();
    await creator;
  });
});

describe("inbox", () => {
  async function people() {
    const base = await dir();
    const alice = { home: path.join(base, "alice"), identity: loadIdentity(path.join(base, "alice")) };
    const bob = { home: path.join(base, "bob"), identity: loadIdentity(path.join(base, "bob")) };
    const mallory = { home: path.join(base, "mallory"), identity: loadIdentity(path.join(base, "mallory")) };
    saveContact(alice.home, "bob", bob.identity.publicKey);
    saveContact(bob.home, "alice", alice.identity.publicKey);
    saveContact(mallory.home, "bob", bob.identity.publicKey);
    return { alice, bob, mallory };
  }

  function open(url: string, who: { home: string; identity: ReturnType<typeof loadIdentity> }, received: Received[]): Inbox {
    const inbox = startInbox({ home: who.home, identity: who.identity, relay: url, onInvitation: (invitation) => received.push(invitation) });
    inboxes.push(inbox);
    return inbox;
  }

  const invitation = (id: string, at = Date.now()) => ({ code: "1234-amber-river-maple-k7f3q2mbxz4a6tu5wnhjy2pc3d", background: "看一下分页", at, id });

  it("takes an invitation from a contact, and nothing from anyone else", async () => {
    const url = await relay();
    const { alice, bob, mallory } = await people();
    const received: Received[] = [];
    const inbox = open(url, bob, received);
    await until(() => inbox.state() === "在线");

    await deliverInvitation({ sender: alice.identity, to: { name: "bob", publicKey: bob.identity.publicKey, added: "" }, invitation: invitation("one"), relay: url });
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ name: "alice", from: alice.identity.publicKey, background: "看一下分页" });

    // Mallory knows bob's key, but bob never saved mallory.
    await expect(
      deliverInvitation({ sender: mallory.identity, to: { name: "bob", publicKey: bob.identity.publicKey, added: "" }, invitation: invitation("two"), relay: url }),
    ).rejects.toThrow(/联系人里没有你/);

    // The relay handing the same invitation over twice, and one that has gone stale.
    const sealed = sealInvitation(alice.identity, bob.identity.publicKey, invitation("three"));
    await sendMessage({ code: inboxAddress(bob.identity.publicKey), text: sealed, relay: url });
    await expect(sendMessage({ code: inboxAddress(bob.identity.publicKey), text: sealed, relay: url })).rejects.toThrow(/已经收过/);
    await expect(
      deliverInvitation({ sender: alice.identity, to: { name: "bob", publicKey: bob.identity.publicKey, added: "" }, invitation: invitation("four", Date.now() - 11 * 60_000), relay: url }),
    ).rejects.toThrow(/过期/);
    await delay(200);
    expect(received.map((item) => item.id)).toEqual(["one", "three"]);

    // Nobody reads an inbox over the relay.
    const queue = await fetch(`${url}/r/${inboxAddress(bob.identity.publicKey)}/agenthop/queue`);
    expect(queue.status).toBe(404);
  });

  it("says a contact is not there, rather than leaving an invitation nowhere", async () => {
    const url = await relay();
    const { alice, bob } = await people();
    await expect(
      deliverInvitation({ sender: alice.identity, to: { name: "bob", publicKey: bob.identity.publicKey, added: "" }, invitation: invitation("x"), relay: url }),
    ).rejects.toThrow(/bob 现在不在线/);
  });

  it("takes its address straight back after a restart", async () => {
    const url = await relay();
    const { alice, bob } = await people();
    const first = open(url, bob, []);
    await until(() => first.state() === "在线");
    await first.close();
    const received: Received[] = [];
    const second = open(url, bob, received);
    // A random token would be turned away here until the relay forgot the first one.
    await until(() => second.state() === "在线", 5_000);
    await deliverInvitation({ sender: alice.identity, to: { name: "bob", publicKey: bob.identity.publicKey, added: "" }, invitation: invitation("again"), relay: url });
    await until(() => received.length === 1);
  });
});

type Result = { text: string; isError: boolean };

async function agent(url: string, home: string, extra: { inviteTtlMs?: number } = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = await startMcpServer({ relay: url, home, ...extra }, serverSide);
  const client = new Client({ name: path.basename(home), version: "0" });
  await client.connect(clientSide);
  closers.push(() => server.close());
  return {
    close: () => server.close(),
    async call(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
      const result = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
    },
  };
}

type Agent = Awaited<ReturnType<typeof agent>>;

/** Talk once by pairing code, and save each other: the way two people become contacts. */
async function acquaint(alice: Agent, bob: Agent): Promise<void> {
  const created = await alice.call("agenthop_create", { background: "第一次见面" });
  const code = created.text.match(/\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{26}/)?.[0];
  const joined = await bob.call("agenthop_join", { code });
  expect(joined.text).toContain("对方身份：不在联系人里");
  await bob.call("agenthop_say", { text: "你好" });
  const confirmed = await alice.call("agenthop_wait", { timeout_seconds: 10 });
  expect(confirmed.text).toContain("对方 identity：不在联系人里");
  expect((await alice.call("agenthop_save_contact", { name: "bob" })).text).toContain("已存为联系人 bob");
  expect((await bob.call("agenthop_save_contact", { name: "alice" })).text).toContain("已存为联系人 alice");
  expect((await alice.call("agenthop_bye")).text).toContain("对话结束了");
  await bob.call("agenthop_wait", { timeout_seconds: 10 });
}

async function waitForInbox(side: Agent): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await side.call("agenthop_status")).text.includes("收件地址：在线")) {
    if (Date.now() > deadline) throw new Error("inbox never came up");
    await delay(100);
  }
}

describe("contacts over MCP", () => {
  it("meets once by code, then talks by name with no code handed over", async () => {
    const url = await relay();
    const base = await dir();
    const alice = await agent(url, path.join(base, "alice"));
    const bob = await agent(url, path.join(base, "bob"));
    await acquaint(alice, bob);
    await waitForInbox(bob);

    expect((await alice.call("agenthop_contacts")).text).toMatch(/bob {2}指纹 [a-z2-7-]{19}/);

    const invited = await alice.call("agenthop_invite", { name: "bob", background: "上次说的分页，再对一下" });
    expect(invited.isError, invited.text).toBe(false);
    expect(invited.text).not.toMatch(/\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{26}/);

    const heard = await bob.call("agenthop_wait", { timeout_seconds: 10 });
    expect(heard.text).toContain("alice 邀请你对话");
    expect(heard.text).toContain("上次说的分页，再对一下");
    expect(heard.text).toContain("先把邀请告诉用户");
    expect((await bob.call("agenthop_status")).text).toContain("待处理的邀请：alice");

    const accepted = await bob.call("agenthop_accept", { from: "alice" });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(accepted.text).toContain("对方身份：alice（联系人");
    expect(accepted.text).toContain("上次说的分页，再对一下");
    await bob.call("agenthop_say", { text: "相符" });
    const confirmed = await alice.call("agenthop_wait", { timeout_seconds: 10 });
    expect(confirmed.text).toContain("对方 identity：bob（联系人");
    expect(confirmed.text).toContain("相符");

    await alice.call("agenthop_say", { text: "页码从 1 开始吗" });
    expect((await bob.call("agenthop_wait", { timeout_seconds: 10 })).text).toContain("页码从 1 开始吗");
    expect((await bob.call("agenthop_bye", { text: "对完了" })).text).toContain("对话结束了");
    expect((await alice.call("agenthop_wait", { timeout_seconds: 10 })).text).toContain("对完了");
  }, 90_000);

  it("lets an invitation be turned down, and the one who sent it hears why at once", async () => {
    const url = await relay();
    const base = await dir();
    const alice = await agent(url, path.join(base, "alice"));
    const bob = await agent(url, path.join(base, "bob"));
    await acquaint(alice, bob);
    await waitForInbox(bob);

    await alice.call("agenthop_invite", { name: "bob", background: "现在有空吗" });
    await bob.call("agenthop_wait", { timeout_seconds: 10 });
    expect((await bob.call("agenthop_decline", { reason: "在开会，一小时后" })).text).toContain("已经回绝了 alice");
    const told = await alice.call("agenthop_wait", { timeout_seconds: 10 });
    expect(told.text).toContain("在开会，一小时后");
    expect(told.text).toContain("对方告别了");
  }, 90_000);

  it("says who is not there, and who is not a contact", async () => {
    const url = await relay();
    const base = await dir();
    const alice = await agent(url, path.join(base, "alice"));
    const bob = await agent(url, path.join(base, "bob"));
    await acquaint(alice, bob);
    await bob.close();

    const offline = await alice.call("agenthop_invite", { name: "bob", background: "在吗" });
    expect(offline.isError).toBe(true);
    expect(offline.text).toContain("bob 现在不在线");
    expect((await alice.call("agenthop_status")).text).toContain("已结束");

    const stranger = await alice.call("agenthop_invite", { name: "carol", background: "在吗" });
    expect(stranger.isError).toBe(true);
    expect(stranger.text).toContain("现有的联系人：bob");

    // Back after a restart, at the same address, straight away.
    const again = await agent(url, path.join(base, "bob"));
    await waitForInbox(again);
    expect((await alice.call("agenthop_invite", { name: "bob", background: "现在呢" })).isError).toBe(false);
    expect((await again.call("agenthop_wait", { timeout_seconds: 10 })).text).toContain("alice 邀请你对话");
  }, 90_000);

  it("closes the room when nobody takes the invitation", async () => {
    const url = await relay();
    const base = await dir();
    const alice = await agent(url, path.join(base, "alice"), { inviteTtlMs: 1500 });
    const bob = await agent(url, path.join(base, "bob"));
    await acquaint(alice, bob);
    await waitForInbox(bob);
    await alice.call("agenthop_invite", { name: "bob", background: "没人理" });
    const expired = await alice.call("agenthop_wait", { timeout_seconds: 10 });
    expect(expired.text).toContain("没有接受邀请，房间已经关掉");
    expect(expired.text).toContain("对话已经结束");
  }, 90_000);

  it("has nothing to wait for with no conversation and nobody who could invite", async () => {
    const url = await relay();
    const alice = await agent(url, path.join(await dir(), "alice"));
    const waited = await alice.call("agenthop_wait", { timeout_seconds: 1 });
    expect(waited.isError).toBe(true);
    expect(waited.text).toContain("agenthop_invite");
    expect((await alice.call("agenthop_save_contact", { name: "x" })).isError).toBe(true);
  });
});
