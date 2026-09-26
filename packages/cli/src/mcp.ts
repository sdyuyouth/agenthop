import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "@agenthop/agent";
import { classifyInput } from "./args.js";
import { brief, BYE, FILE, lineQueue, runSession, WORKING, write, type LogEntry, type SessionOptions } from "./session.js";
import { findContact, fingerprint, forgetContact, loadContacts, loadIdentity, saveContact, type Identity } from "./identity.js";
import { deliverInvitation, INVITE_TTL_MS, startInbox, type Inbox, type Received } from "./inbox.js";
import { version } from "./version.js";

/**
 * agenthop as an MCP server. The harness starts this process and keeps it alive, so the
 * conversation lives here rather than in one long tool call, and nobody has to find a way to
 * write into a running process's standard input — the thing most harnesses cannot do.
 *
 * The session engine is the one the command line uses, unchanged. This file only turns tool
 * calls into lines on its input and its log into tool results. Standard output belongs to the
 * protocol, so the log's live copy is routed here instead (`emit`) and never printed.
 */

export type McpOptions = {
  relay?: string;
  pass?: string;
  home?: string;
  /** The longest a single `wait` may block. Below the usual harness tool timeout. */
  waitCapMs?: number;
  /** How long an invitation waits for its contact to come in before its room is closed. */
  inviteTtlMs?: number;
};

const DEFAULT_WAIT_S = 50;
const MAX_WAIT_S = 290;

/** Lines that mean it is this side's turn, or that there is nothing more to wait for. */
const TURN = new Set(["hello", "confirm", "say", "files", "bye"]);
const OVER = new Set(["gone", "expired"]);
/** Of this side's own lines, the ones worth reporting back; the rest are echoes of what it just did. */
const LOCAL_WORTH_SAYING = new Set(["ready", "undelivered", "throttled", "reconnecting", "reconnected", "expired", "input-closed", "bye"]);

type Conversation = {
  seat: "create" | "join";
  lines: ReturnType<typeof lineQueue>;
  entries: LogEntry[];
  /** How far `wait` has reported. */
  seen: number;
  done: boolean;
  failure?: string;
  stop: AbortController;
  /** The other side's public key, once it has shown one: what `save_contact` keeps. */
  peerKey?: string;
  /** Lines a tool call already answered with, so `wait` does not report them a second time. */
  told: Set<LogEntry>;
};

type Pending = Received & { reported: boolean };

const INSTRUCTIONS = `agenthop 让你和另一台机器上的 agent 对话，消息端到端加密。

开房间：agenthop_create(background)，把返回的配对码整串交给用户转给对方。
加入：agenthop_join(code)，读到对方的背景后判断是否和你的上下文相符；相符就用 agenthop_say 写一句确认，不相符就问用户。
之后：agenthop_wait 等对方说话（只在轮到你时返回），agenthop_say 回复。收到一句先 agenthop_working 回一张收条再干活，对方就不会以为你掉线了。
结束：agenthop_bye。

联系人：对话里对方会表明身份（peer identity）。用户想以后按名字找它，就用 agenthop_save_contact 存下；两边互相存过之后，agenthop_invite(名字, 背景) 就能直接邀请，不用再转交配对码，前提是对方的 agent 此刻开着 agenthop。
没有对话时 agenthop_wait 等的是别人的邀请。收到邀请先告诉用户，用户同意再 agenthop_accept，不接就 agenthop_decline；用户事先说过"有人找就接"的除外。

每次工具调用的结果就是对话本身，要让用户看得到；日志文件的路径在开房间或加入时给出。`;

export async function startMcpServer(options: McpOptions = {}, transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = new McpServer({ name: "agenthop", version }, { instructions: INSTRUCTIONS });
  const home = options.home ?? path.join(homedir(), ".agenthop");
  const waitCapMs = options.waitCapMs ?? MAX_WAIT_S * 1000;
  const inviteTtlMs = options.inviteTtlMs ?? INVITE_TTL_MS;
  let current: Conversation | undefined;
  let identity: Identity | undefined;
  let inbox: Inbox | undefined;
  const invitations: Pending[] = [];

  /** This home's identity, made on first use. A home that cannot hold one still has conversations. */
  function self(): Identity | undefined {
    if (!identity) {
      try {
        identity = loadIdentity(home);
      } catch {
        return undefined;
      }
    }
    return identity;
  }

  /** The inbox is held open while there is anyone who could send to it, and not otherwise. */
  function syncInbox(): void {
    let known = false;
    try {
      known = loadContacts(home).length > 0;
    } catch {
      known = false;
    }
    const me = known ? self() : undefined;
    if (me && !inbox) {
      inbox = startInbox({ home, identity: me, relay: options.relay, pass: options.pass, onInvitation: (invitation) => invitations.push({ ...invitation, reported: false }) });
    } else if (!me && inbox) {
      void inbox.close();
      inbox = undefined;
    }
  }

  /** Invitations still worth answering. One whose room has most likely gone is dropped. */
  function pending(): Pending[] {
    const cutoff = Date.now() - INVITE_TTL_MS;
    for (let i = invitations.length - 1; i >= 0; i--) if (invitations[i]!.at < cutoff) invitations.splice(i, 1);
    return invitations;
  }

  /** The invitation meant by `from`, taken off the list, or why there is none. */
  function take(from: string | undefined): Pending | string {
    const list = pending();
    if (list.length === 0) return "没有待处理的邀请。";
    const matches = from?.trim() ? list.filter((invitation) => invitation.name === from.trim()) : list;
    if (matches.length === 0) return `没有来自"${from}"的邀请。待处理的：${names(list)}。`;
    if (!from?.trim() && new Set(matches.map((invitation) => invitation.name)).size > 1) return `有几个人在邀请你：${names(list)}。说明接哪一个。`;
    const chosen = matches[matches.length - 1]!;
    for (let i = invitations.length - 1; i >= 0; i--) if (invitations[i]!.name === chosen.name) invitations.splice(i, 1);
    return chosen;
  }

  /** What every conversation this server runs is started with. */
  function sessionOptions(c: Conversation): SessionOptions {
    return {
      lines: c.lines,
      emit: (entry) => c.entries.push(entry),
      relay: options.relay,
      pass: options.pass,
      home,
      signal: c.stop.signal,
      identity: self() ?? false,
      onPeerKey: (key) => {
        c.peerKey = key;
      },
    };
  }

  function begin(seat: Conversation["seat"], run: (conversation: Conversation) => Promise<void>): Conversation {
    const conversation: Conversation = { seat, lines: lineQueue(), entries: [], seen: 0, done: false, stop: new AbortController(), told: new Set() };
    current = conversation;
    void run(conversation).then(
      () => {
        conversation.done = true;
      },
      (error: unknown) => {
        conversation.failure = error instanceof Error ? error.message : String(error);
        conversation.done = true;
      },
    );
    return conversation;
  }

  function busy(): string | undefined {
    if (current && !over(current)) return "已经有一场对话在进行。先用 agenthop_bye 结束它，再开下一场。";
    return undefined;
  }

  function active(): Conversation | string {
    if (!current) return NO_CONVERSATION;
    if (over(current)) return `这场对话已经结束了。${current.failure ? `\n${current.failure}` : ""}`;
    return current;
  }

  server.registerTool(
    "agenthop_create",
    {
      description:
        "开一个房间，返回配对码。把配对码整串交给用户，由用户转给对方；对方的 agent 用 agenthop_join 加入。background 是这次要谈的事，会作为开场白发给对方，对方据此判断是不是找对了人。",
      inputSchema: {
        background: z.string().describe("这次对话的任务背景"),
        accept_files: z.boolean().optional().describe("是否把对方发来的文件存到磁盘（默认不存，只记文件名）"),
      },
    },
    async ({ background, accept_files }) => {
      const taken = busy();
      if (taken) return failure(taken);
      const conversation = begin("create", (c) =>
        runSession({ ...sessionOptions(c), hello: background, keepFiles: accept_files === true }),
      );
      const code = await until(conversation, (entry) => entry.side === "local" && entry.state === "waiting", 20_000);
      if (!code) return failure(conversation.failure ?? "房间没有开起来。");
      const log = logPath(conversation);
      return reply(
        `房间开好了。配对码：\n${code.text}\n\n` +
          "把这一整串原样交给对方，最后一段是这次对话的密钥，少了它对方进不来。" +
          "对方加入并确认之后，用 agenthop_wait 等它说话。" +
          (log ? `\n日志：${log}（看实时进展：tail -f ${log}）` : ""),
      );
    },
  );

  server.registerTool(
    "agenthop_join",
    {
      description:
        "用配对码加入对方的房间，等到对方的开场白（任务背景）后返回。读完后判断它是否和你的上下文相符：相符就用 agenthop_say 写一句确认，通道随即打开；不相符就问用户，不要回复。",
      inputSchema: {
        code: z.string().describe("对方给的配对码，整串"),
        accept_files: z.boolean().optional().describe("是否把对方发来的文件存到磁盘（默认不存，只记文件名）"),
      },
    },
    async ({ code, accept_files }) => {
      const taken = busy();
      if (taken) return failure(taken);
      let normalized: string;
      try {
        const input = classifyInput([code]);
        if (input.kind !== "join") return failure("这不像一个配对码。配对码是四位数字、三个英文词，再加一段 26 位的密钥。");
        normalized = input.code;
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      const conversation = begin("join", (c) =>
        runSession({ ...sessionOptions(c), code: normalized, keepFiles: accept_files === true }),
      );
      const hello = await until(conversation, (entry) => entry.side === "peer" && entry.state === "hello", 30_000);
      if (!hello) return failure(conversation.failure ?? refusal(conversation) ?? "等了 30 秒没等到对方的开场白。房间可能已经过期，请对方重新开一个。");
      conversation.seen = conversation.entries.length;
      const log = logPath(conversation);
      return reply(
        `已加入。${introduction(conversation)}对方的任务背景：\n${hello.text}\n\n` +
          "判断它和你的上下文是否相符。相符就用 agenthop_say 写一句确认；不相符就问用户，不要回复。" +
          (log ? `\n日志：${log}（看实时进展：tail -f ${log}）` : ""),
      );
    },
  );

  server.registerTool(
    "agenthop_say",
    {
      description:
        "对对方说一句话，可以多行。返回是否送达。加入方的第一句就是对开场白的确认。收条用 agenthop_working，结束用 agenthop_bye。",
      inputSchema: { text: z.string().describe("要说的话") },
    },
    async ({ text }) => {
      const conversation = active();
      if (typeof conversation === "string") return failure(conversation);
      // A line on the command line may be a command; a line handed to `say` is always words.
      const first = text.trim().split("\n")[0] ?? "";
      for (const [command, tool] of [[BYE, "agenthop_bye"], [WORKING, "agenthop_working"], [FILE, "agenthop_send_file"]] as const) {
        if (first === command || first.startsWith(`${command} `)) return failure(`要${tool === "agenthop_bye" ? "结束对话" : tool === "agenthop_working" ? "发收条" : "发文件"}请用 ${tool}。`);
      }
      if (!text.trim()) return failure("没有内容可说。");
      const mark = conversation.entries.length;
      const line = text.trim();
      conversation.lines.push(line);
      const outcome = await settle(conversation, mark, (entry) => (["say", "confirm"].includes(entry.state) && entry.text === line) || (entry.state === "undelivered" && unsentAs(entry, line)), 15_000);
      if (outcome) conversation.told.add(outcome);
      if (!outcome) {
        const open = conversation.entries.some((entry) => entry.state === "ready");
        return reply(open ? "还没发出去，结果会出现在 agenthop_wait 里。" : "通道还没打开（对方还没确认），这句会在打开后按顺序发出。");
      }
      if (outcome.state === "confirm") return reply("确认已送达，通道打开了。用 agenthop_wait 等对方说话。");
      if (outcome.state === "say") return reply("已送达。用 agenthop_wait 等对方回复。");
      if (outcome.state === "throttled") return reply(`${outcome.text}。不用重发。`);
      return failure(`没有送到对方：${outcome.text}`);
    },
  );

  server.registerTool(
    "agenthop_working",
    {
      description:
        "回一张收条：告诉对方你收到了、正在处理，以及大概要多久。对方看到的是进度而不是一句需要回应的话，它会安心等着，不会以为你掉线了。收到对方一句后先调用它，再开始干活。",
      inputSchema: { text: z.string().describe("在做什么、大概多久，例如：收到，我去查这三个文件，大概两三分钟").optional() },
    },
    async ({ text }) => {
      const conversation = active();
      if (typeof conversation === "string") return failure(conversation);
      const mark = conversation.entries.length;
      const note = text?.trim() ?? "";
      const line = note ? `${WORKING} ${note}` : WORKING;
      conversation.lines.push(line);
      const outcome = await settle(conversation, mark, (entry) => (entry.state === "working" && entry.text === note) || (entry.state === "undelivered" && unsentAs(entry, line)), 15_000);
      if (outcome) conversation.told.add(outcome);
      if (outcome?.state === "undelivered") return failure(`收条没有送到：${outcome.text}`);
      if (outcome?.state === "throttled") return reply(`${outcome.text}。收条排在里面，会按顺序发出。`);
      return reply("收条已发出。");
    },
  );

  server.registerTool(
    "agenthop_send_file",
    {
      description: `发一个文件给对方（最大 ${MAX_ATTACHMENT_BYTES / 1024} KiB），文件内容和文件名都端到端加密，中继看不到。对方要在开房间或加入时允许接收文件才会存到磁盘，否则只记下文件名。`,
      inputSchema: { path: z.string().describe("本机文件的路径") },
    },
    async ({ path: filePath }) => {
      const conversation = active();
      if (typeof conversation === "string") return failure(conversation);
      const mark = conversation.entries.length;
      const line = `${FILE} ${path.resolve(filePath)}`;
      const name = path.basename(filePath);
      conversation.lines.push(line);
      const outcome = await settle(conversation, mark, (entry) => (entry.state === "files" && entry.text.startsWith(`${name}（`)) || (entry.state === "undelivered" && unsentAs(entry, line)), 30_000);
      if (outcome) conversation.told.add(outcome);
      if (!outcome) return reply("文件还没发出去（对方可能还没确认），结果会出现在 agenthop_wait 里。");
      if (outcome.state === "files") return reply(`已送达：${outcome.text}`);
      if (outcome.state === "throttled") return reply(`${outcome.text}。不用重发。`);
      return failure(`没有送到对方：${outcome.text}`);
    },
  );

  server.registerTool(
    "agenthop_wait",
    {
      description:
        "等对方说话。只在轮到你时返回（对方说了话、确认了、或告别了），或者等到超时。返回这期间的所有新动静，包括对方的进度（working）。超时没等到就再调一次。没有进行中的对话时，等的是联系人发来的邀请。",
      inputSchema: {
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`最多等几秒，默认 ${DEFAULT_WAIT_S}`),
      },
    },
    async ({ timeout_seconds }) => {
      const conversation = current;
      const ms = Math.min((timeout_seconds ?? DEFAULT_WAIT_S) * 1000, waitCapMs);
      const settled = !conversation || (conversation.done && conversation.seen >= conversation.entries.length);
      if (settled && inbox) return reply(await waitForInvitations(ms));
      if (!conversation) return failure(NO_CONVERSATION);
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !conversation.done && !turnSince(conversation)) await delay(100);
      const fresh = conversation.entries.slice(conversation.seen);
      conversation.seen = conversation.entries.length;
      const shown = fresh.filter((entry) => !conversation.told.has(entry) && (entry.side === "peer" || LOCAL_WORTH_SAYING.has(entry.state)));
      const body = shown.map(describe).join("\n");
      let status: string;
      if (conversation.done || shown.some((entry) => OVER.has(entry.state))) {
        status = `对话已经结束。${conversation.failure ?? ""}`.trim();
      } else if (shown.some((entry) => entry.side === "peer" && entry.state === "bye")) {
        status = "对方告别了，对话结束。";
      } else if (shown.some((entry) => entry.side === "peer" && TURN.has(entry.state))) {
        status = "轮到你了。";
      } else if (shown.some((entry) => entry.side === "peer" && entry.state === "working")) {
        status = "对方还在处理，再调一次 agenthop_wait 接着等。";
      } else {
        status = `${Math.round(ms / 1000)} 秒内没有新消息，再调一次 agenthop_wait 接着等。`;
      }
      const also = invitationNews();
      return reply([body, status, also].filter(Boolean).join("\n\n"));
    },
  );

  server.registerTool(
    "agenthop_bye",
    {
      description: "结束对话，可以带一句告别的话。对方会把告别说回来，然后两边各自结束。",
      inputSchema: { text: z.string().describe("告别的话").optional() },
    },
    async ({ text }) => {
      const conversation = active();
      if (typeof conversation === "string") return failure(conversation);
      conversation.lines.push(text?.trim() ? `${BYE} ${text.trim()}` : BYE);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !conversation.done) await delay(100);
      const fresh = conversation.entries.slice(conversation.seen).filter((entry) => !conversation.told.has(entry) && (entry.side === "peer" || LOCAL_WORTH_SAYING.has(entry.state)));
      conversation.seen = conversation.entries.length;
      const body = fresh.map(describe).join("\n");
      const status = conversation.done ? "对话结束了。" : "告别已发出，还在等对方说回来。";
      return reply(body ? `${body}\n\n${status}` : status);
    },
  );

  server.registerTool(
    "agenthop_status",
    { description: "看当前对话的状态：在哪一步、配对码、日志在哪；以及本机的身份、收件地址和待处理的邀请。" },
    async () => {
      if (!current) return reply(["现在没有对话。", ...standing()].join("\n"));
      const c = current;
      const has = (side: string, state: string) => c.entries.some((entry) => entry.side === side && entry.state === state);
      const phase = over(c)
        ? "已结束"
        : has("local", "ready")
          ? "对话中"
          : c.seat === "create"
            ? has("peer", "connected")
              ? "对方已加入，等它确认"
              : "等对方用配对码加入"
            : "等你确认对方的背景";
      const code = c.entries.find((entry) => entry.side === "local" && entry.state === "waiting")?.text;
      const log = logPath(c);
      return reply(
        [`这一端：${c.seat === "create" ? "创建方" : "加入方"}`, `阶段：${phase}`, code ? `配对码：${code}` : "", log ? `日志：${log}` : "", c.failure ?? "", ...standing()]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );


  server.registerTool(
    "agenthop_save_contact",
    {
      description:
        "把这场对话（进行中或刚结束的）里的对方存为联系人。以后用 agenthop_invite 按名字邀请它，不用再转交配对码。对方也要把你存为联系人，邀请才会被收下。",
      inputSchema: { name: z.string().describe("给对方起的名字，例如 alice 或 小王的电脑") },
    },
    async ({ name }) => {
      if (!current) return failure("现在没有对话，没有可以存的人。联系人是从一场对话里存下的：先用配对码对话一次。");
      if (!current.peerKey) return failure("这场对话里对方没有表明身份（多半是 v0.5 之前的版本），存不了。请对方 agenthop update 之后再对话一次。");
      let saved: ReturnType<typeof saveContact>;
      try {
        saved = saveContact(home, name, current.peerKey);
      } catch (error) {
        return failure(`没有存成：${error instanceof Error ? error.message : String(error)}`);
      }
      if (typeof saved === "string") return failure(saved);
      syncInbox();
      const renamed = saved.renamedFrom && saved.renamedFrom !== saved.saved.name ? `（原来叫 ${saved.renamedFrom}）` : "";
      return reply(
        `已存为联系人 ${saved.saved.name}${renamed}，指纹 ${fingerprint(saved.saved.publicKey)}。\n` +
          `以后用 agenthop_invite("${saved.saved.name}", 背景) 直接邀请它。对方也要把你存为联系人，邀请才会被收下。\n` +
          "这个身份是从这场对话里认下的。在意的话，可以请对方在别的渠道念一遍它的指纹核对（它用 agenthop_contacts 能看到自己的）。",
      );
    },
  );

  server.registerTool(
    "agenthop_contacts",
    { description: "列出联系人（名字、指纹），以及本机自己的指纹、收件地址是否在线、待处理的邀请。" },
    async () => {
      let contacts: ReturnType<typeof loadContacts>;
      try {
        contacts = loadContacts(home);
      } catch (error) {
        return failure(`读不了联系人：${error instanceof Error ? error.message : String(error)}`);
      }
      const rows = contacts.map((contact) => `  ${contact.name}  指纹 ${fingerprint(contact.publicKey)}  存于 ${contact.added.slice(0, 10)}`);
      return reply(
        [contacts.length > 0 ? `联系人：\n${rows.join("\n")}` : "还没有联系人。和对方用配对码对话一次，再用 agenthop_save_contact 存下。", ...standing()].join("\n"),
      );
    },
  );

  server.registerTool(
    "agenthop_forget_contact",
    { description: "删掉一个联系人。之后它的邀请不会再被收下，你也不能再按名字邀请它。", inputSchema: { name: z.string().describe("联系人的名字") } },
    async ({ name }) => {
      let gone: ReturnType<typeof forgetContact>;
      try {
        gone = forgetContact(home, name);
      } catch (error) {
        return failure(`没有删成：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!gone) return failure(`联系人里没有"${name}"。`);
      syncInbox();
      return reply(`已删掉联系人 ${gone.name}（指纹 ${fingerprint(gone.publicKey)}）。`);
    },
  );

  server.registerTool(
    "agenthop_invite",
    {
      description:
        "按名字邀请一个联系人对话，不用转交配对码。background 是这次要谈的事，对方接受后会作为开场白收到。对方的 agent 此刻要开着 agenthop 才收得到；不在线会直接告诉你。送到之后用 agenthop_wait 等它加入并确认。",
      inputSchema: {
        name: z.string().describe("联系人的名字"),
        background: z.string().describe("这次对话的任务背景"),
        accept_files: z.boolean().optional().describe("是否把对方发来的文件存到磁盘（默认不存，只记文件名）"),
      },
    },
    async ({ name, background, accept_files }) => {
      const taken = busy();
      if (taken) return failure(taken);
      let contact: ReturnType<typeof findContact>;
      try {
        contact = findContact(home, name);
      } catch (error) {
        return failure(`读不了联系人：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!contact) return failure(`联系人里没有"${name}"。${contactNames()}`);
      const me = self();
      if (!me) return failure("本机的身份文件读不了，发不了邀请。");
      const to = contact;
      const conversation = begin("create", (c) =>
        runSession({ ...sessionOptions(c), hello: background, keepFiles: accept_files === true, expectPeer: to.publicKey }),
      );
      const waiting = await until(conversation, (entry) => entry.side === "local" && entry.state === "waiting", 20_000);
      if (!waiting) return failure(conversation.failure ?? "房间没有开起来。");
      const log = logPath(conversation);
      try {
        await deliverInvitation({ sender: me, to, invitation: { code: waiting.text, background, at: Date.now(), id: randomUUID() }, relay: options.relay, pass: options.pass });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (log) write(log, "local", "undelivered", `给 ${to.name} 的邀请：${reason}`);
        conversation.stop.abort();
        await until(conversation, () => false, 5_000);
        conversation.seen = conversation.entries.length;
        return failure(`${reason}\n刚开的房间已经关掉。可以晚点再邀请，或者用 agenthop_create 开房间、把配对码交给用户转过去。`);
      }
      // Nobody can take the invitation after it goes stale at the other end, so neither is the room kept.
      setTimeout(() => {
        if (conversation.done || conversation.entries.some((entry) => entry.side === "peer" && entry.state === "connected")) return;
        if (log) write(log, "local", "expired", `${to.name} 在 ${Math.round(inviteTtlMs / 60_000)} 分钟内没有接受邀请，房间已经关掉`);
        conversation.stop.abort();
      }, inviteTtlMs).unref();
      return reply(
        `邀请已经送到 ${to.name}。它那边的 agent 通常要先问过用户才会接受。用 agenthop_wait 等它加入并确认。` +
          (log ? `\n日志：${log}（看实时进展：tail -f ${log}）` : ""),
      );
    },
  );

  server.registerTool(
    "agenthop_accept",
    {
      description:
        "接受一个联系人的邀请：加入它开的房间，返回它的开场白（任务背景）。先把邀请告诉用户，用户同意了再调用，除非用户事先说过有人找就接。读完开场白的做法和 agenthop_join 一样：相符就用 agenthop_say 写一句确认。",
      inputSchema: {
        from: z.string().optional().describe("发邀请的联系人名字；只有一个人在邀请时可以不填"),
        accept_files: z.boolean().optional().describe("是否把对方发来的文件存到磁盘（默认不存，只记文件名）"),
      },
    },
    async ({ from, accept_files }) => {
      const taken = busy();
      if (taken) return failure(taken);
      const invitation = take(from);
      if (typeof invitation === "string") return failure(invitation);
      const conversation = begin("join", (c) =>
        runSession({ ...sessionOptions(c), code: invitation.code, keepFiles: accept_files === true, expectPeer: invitation.from }),
      );
      const hello = await until(conversation, (entry) => entry.side === "peer" && entry.state === "hello", 30_000);
      if (!hello) return failure(conversation.failure ?? refusal(conversation) ?? `等了 30 秒没等到 ${invitation.name} 的开场白，它可能已经不等了。`);
      conversation.seen = conversation.entries.length;
      const log = logPath(conversation);
      return reply(
        `已接受 ${invitation.name} 的邀请。${introduction(conversation)}对方的任务背景：\n${hello.text}\n\n` +
          "判断它和你的上下文是否相符。相符就用 agenthop_say 写一句确认；不相符就问用户，不要回复。" +
          (log ? `\n日志：${log}（看实时进展：tail -f ${log}）` : ""),
      );
    },
  );

  server.registerTool(
    "agenthop_decline",
    {
      description: "回绝一个联系人的邀请，可以带一句理由。对方会马上知道，不用干等。",
      inputSchema: {
        from: z.string().optional().describe("发邀请的联系人名字；只有一个人在邀请时可以不填"),
        reason: z.string().optional().describe("回绝的理由，例如：现在在忙，一小时后再找我"),
      },
    },
    async ({ from, reason }) => {
      const invitation = take(from);
      if (typeof invitation === "string") return failure(invitation);
      // Its own short conversation, apart from `current`: join, say goodbye with the reason, leave.
      const lines = lineQueue();
      lines.push(`${BYE} ${reason?.trim() || "现在不方便"}`);
      let finished = false;
      const run = runSession({ code: invitation.code, lines, emit: () => undefined, relay: options.relay, pass: options.pass, home, identity: self() ?? false, expectPeer: invitation.from }).then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await Promise.race([run, delay(25_000)]);
      return reply(finished ? `已经回绝了 ${invitation.name}，它那边会看到你的理由。` : `回绝已经发出，还没等到 ${invitation.name} 那边回应。`);
    },
  );

  async function waitForInvitations(ms: number): Promise<string> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !pending().some((invitation) => !invitation.reported)) await delay(100);
    return invitationNews() || `${Math.round(ms / 1000)} 秒内没有邀请，再调一次 agenthop_wait 接着等。（收件地址：${inbox?.state() ?? "没有挂着"}）`;
  }

  /** Invitations not yet reported, as the agent should read them; each is reported once. */
  function invitationNews(): string {
    const fresh = pending().filter((invitation) => !invitation.reported);
    if (fresh.length === 0) return "";
    for (const invitation of fresh) invitation.reported = true;
    const lines = fresh.map((invitation) => `${invitation.name} 邀请你对话（${clock(invitation.at)}，指纹 ${fingerprint(invitation.from)}）：\n${readable(invitation.background)}`);
    const busyNow = current && !current.done;
    return (
      `${lines.join("\n\n")}\n\n` +
      (busyNow
        ? "你正在另一场对话里。先告诉用户有这个邀请；要接的话先 agenthop_bye 结束手上这场，再 agenthop_accept。"
        : `先把邀请告诉用户，用户同意了再 agenthop_accept("${fresh[fresh.length - 1]!.name}")；不接就 agenthop_decline 带一句理由。用户事先说过有人找就接的，可以直接接受。`)
    );
  }

  /** What stands apart from any one conversation: this machine's identity, its inbox, invitations. */
  function standing(): string[] {
    const me = self();
    const waiting = pending();
    return [
      me ? `本机指纹：${fingerprint(me.publicKey)}` : "",
      inbox ? `收件地址：${inbox.state()}` : "",
      waiting.length > 0 ? `待处理的邀请：${names(waiting)}` : "",
    ].filter(Boolean);
  }

  function contactNames(): string {
    try {
      const contacts = loadContacts(home);
      return contacts.length > 0 ? `现有的联系人：${contacts.map((contact) => contact.name).join("、")}。` : "还没有联系人。";
    } catch {
      return "";
    }
  }

  server.server.onclose = () => {
    void inbox?.close();
    inbox = undefined;
    current?.stop.abort();
  };
  await server.connect(transport);
  syncInbox();
  return server;
}

const NO_CONVERSATION = "现在没有对话。先用 agenthop_create 开房间、agenthop_join 加入，或用 agenthop_invite 邀请联系人。";

function names(invitations: Received[]): string {
  return [...new Set(invitations.map((invitation) => invitation.name))].join("、");
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/** Why a conversation ended before the hello, when the other side was turned away. */
function refusal(conversation: Conversation): string | undefined {
  const refused = conversation.entries.filter((entry) => entry.side === "peer" && entry.state === "refused").at(-1);
  return refused ? `没有加入：${refused.text}` : undefined;
}

/** Who the other side turned out to be, when it said. */
function introduction(conversation: Conversation): string {
  const shown = conversation.entries.find((entry) => entry.side === "peer" && entry.state === "identity");
  return shown ? `对方身份：${shown.text}。\n` : "";
}

/**
 * Whether anything more can be said. A goodbye from either side is the end, even while the
 * process lingers a moment so the other side can read it: a line written then would be queued
 * behind the goodbye and never go.
 */
function over(conversation: Conversation): boolean {
  return (
    conversation.done ||
    conversation.entries.some((entry) => entry.state === "bye" || entry.state === "expired" || (entry.side === "peer" && entry.state === "gone"))
  );
}

/**
 * What happened to the line a tool call just queued — its own line, not merely the next one
 * written: an agent that calls `say` several times at once must not be told each of them arrived
 * when only the first has. While the relay is holding this side back, the answer is that it is
 * queued, which is true and is all there is to know for now.
 */
async function settle(conversation: Conversation, from: number, mine: (entry: LogEntry) => boolean, ms: number): Promise<LogEntry | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = conversation.entries.slice(from).find((entry) => entry.side === "local" && mine(entry));
    if (found) return found;
    const held = holding(conversation);
    if (held) return held;
    if (conversation.done || Date.now() > deadline) return undefined;
    await delay(50);
  }
}

/** The throttle note, while lines are still waiting behind it. */
function holding(conversation: Conversation): LogEntry | undefined {
  for (let i = conversation.entries.length - 1; i >= 0; i--) {
    const entry = conversation.entries[i]!;
    if (entry.side !== "local") continue;
    if (entry.state === "throttled") return entry;
    if (["say", "confirm", "working", "files"].includes(entry.state)) return undefined;
  }
  return undefined;
}

/** Whether an `undelivered` line is this one. Long lines are written down shortened. */
function unsentAs(entry: LogEntry, line: string): boolean {
  return entry.text === line || entry.text.startsWith(`${line}（`) || entry.text.startsWith(brief(line));
}

/** Wait for an entry after `from` that satisfies `match`, or for the conversation to end. */
async function until(conversation: Conversation, match: (entry: LogEntry) => boolean, ms: number, from = 0): Promise<LogEntry | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = conversation.entries.slice(from).find(match);
    if (found) return found;
    if (conversation.done || Date.now() > deadline) return undefined;
    await delay(50);
  }
}

function turnSince(conversation: Conversation): boolean {
  return conversation.entries
    .slice(conversation.seen)
    .some((entry) => (entry.side === "peer" && (TURN.has(entry.state) || OVER.has(entry.state))) || (entry.side === "local" && entry.state === "expired"));
}

function logPath(conversation: Conversation): string | undefined {
  return conversation.entries.find((entry) => entry.side === "local" && entry.state === "log")?.text;
}

/** A log entry as the agent reads it. The text keeps its line breaks; the log file is where they become ↵. */
function describe(entry: LogEntry): string {
  const who = entry.side === "peer" ? "对方" : "这边";
  const clock = entry.time.slice(11, 19);
  return `[${clock}] ${who} ${entry.state}${entry.text ? `：${readable(entry.text)}` : ""}`;
}

/** Line breaks stay; what would drive a terminal or reorder text on screen does not. */
function readable(text: string): string {
  return text
    .replace(/\r\n|[\r\u0085\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
