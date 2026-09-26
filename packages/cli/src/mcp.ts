import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "@agenthop/agent";
import { classifyInput } from "./args.js";
import { BYE, FILE, lineQueue, runSession, WORKING, type LogEntry } from "./session.js";
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
};

const INSTRUCTIONS = `agenthop 让你和另一台机器上的 agent 对话，消息端到端加密。

开房间：agenthop_create(background)，把返回的配对码整串交给用户转给对方。
加入：agenthop_join(code)，读到对方的背景后判断是否和你的上下文相符；相符就用 agenthop_say 写一句确认，不相符就问用户。
之后：agenthop_wait 等对方说话（只在轮到你时返回），agenthop_say 回复。收到一句先 agenthop_working 回一张收条再干活，对方就不会以为你掉线了。
结束：agenthop_bye。

每次工具调用的结果就是对话本身，要让用户看得到；日志文件的路径在开房间或加入时给出。`;

export async function startMcpServer(options: McpOptions = {}, transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = new McpServer({ name: "agenthop", version }, { instructions: INSTRUCTIONS });
  const home = options.home ?? path.join(homedir(), ".agenthop");
  const waitCapMs = options.waitCapMs ?? MAX_WAIT_S * 1000;
  let current: Conversation | undefined;

  function begin(seat: Conversation["seat"], run: (conversation: Conversation) => Promise<void>): Conversation {
    const conversation: Conversation = { seat, lines: lineQueue(), entries: [], seen: 0, done: false };
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
    if (current && !current.done) return "已经有一场对话在进行。先用 agenthop_bye 结束它，再开下一场。";
    return undefined;
  }

  function active(): Conversation | string {
    if (!current) return "现在没有对话。先用 agenthop_create 开房间，或用 agenthop_join 加入。";
    if (current.done) return `这场对话已经结束了。${current.failure ? `\n${current.failure}` : ""}`;
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
        runSession({ hello: background, lines: c.lines, emit: (entry) => c.entries.push(entry), relay: options.relay, pass: options.pass, home, keepFiles: accept_files === true }),
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
        runSession({ code: normalized, lines: c.lines, emit: (entry) => c.entries.push(entry), relay: options.relay, pass: options.pass, home, keepFiles: accept_files === true }),
      );
      const hello = await until(conversation, (entry) => entry.side === "peer" && entry.state === "hello", 30_000);
      if (!hello) return failure(conversation.failure ?? "等了 30 秒没等到对方的开场白。房间可能已经过期，请对方重新开一个。");
      conversation.seen = conversation.entries.length;
      const log = logPath(conversation);
      return reply(
        `已加入。对方的任务背景：\n${hello.text}\n\n` +
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
      conversation.lines.push(text);
      const outcome = await until(
        conversation,
        (entry) => entry.side === "local" && ["say", "confirm", "undelivered", "throttled"].includes(entry.state),
        15_000,
        mark,
      );
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
      conversation.lines.push(text?.trim() ? `${WORKING} ${text.trim()}` : WORKING);
      const outcome = await until(conversation, (entry) => entry.side === "local" && ["working", "undelivered", "throttled"].includes(entry.state), 15_000, mark);
      if (outcome?.state === "undelivered") return failure(`收条没有送到：${outcome.text}`);
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
      conversation.lines.push(`${FILE} ${path.resolve(filePath)}`);
      const outcome = await until(conversation, (entry) => entry.side === "local" && ["files", "undelivered", "throttled"].includes(entry.state), 30_000, mark);
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
        "等对方说话。只在轮到你时返回（对方说了话、确认了、或告别了），或者等到超时。返回这期间的所有新动静，包括对方的进度（working）。超时没等到就再调一次。",
      inputSchema: {
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`最多等几秒，默认 ${DEFAULT_WAIT_S}`),
      },
    },
    async ({ timeout_seconds }) => {
      const conversation = current;
      if (!conversation) return failure("现在没有对话。先用 agenthop_create 开房间，或用 agenthop_join 加入。");
      const ms = Math.min((timeout_seconds ?? DEFAULT_WAIT_S) * 1000, waitCapMs);
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !conversation.done && !turnSince(conversation)) await delay(100);
      const fresh = conversation.entries.slice(conversation.seen);
      conversation.seen = conversation.entries.length;
      const shown = fresh.filter((entry) => entry.side === "peer" || LOCAL_WORTH_SAYING.has(entry.state));
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
      return reply(body ? `${body}\n\n${status}` : status);
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
      const fresh = conversation.entries.slice(conversation.seen).filter((entry) => entry.side === "peer" || LOCAL_WORTH_SAYING.has(entry.state));
      conversation.seen = conversation.entries.length;
      const body = fresh.map(describe).join("\n");
      const status = conversation.done ? "对话结束了。" : "告别已发出，还在等对方说回来。";
      return reply(body ? `${body}\n\n${status}` : status);
    },
  );

  server.registerTool(
    "agenthop_status",
    { description: "看当前对话的状态：在哪一步、配对码、日志在哪。" },
    async () => {
      if (!current) return reply("现在没有对话。");
      const c = current;
      const has = (side: string, state: string) => c.entries.some((entry) => entry.side === side && entry.state === state);
      const phase = c.done
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
        [`这一端：${c.seat === "create" ? "创建方" : "加入方"}`, `阶段：${phase}`, code ? `配对码：${code}` : "", log ? `日志：${log}` : "", c.failure ?? ""]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  await server.connect(transport);
  return server;
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
