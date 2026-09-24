import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { generateCode, splitCode } from "@agenthop/tunnel";
import { readQueue, roomBase, sendMessage } from "./send.js";
import { RECOVER_MS, startHost, type RunningHost } from "./host.js";
import { channel, type Channel } from "./seal.js";
import { type SessionEvent } from "./talk.js";

/** Written on stdin to end the conversation on purpose. */
export const BYE = "/bye";
/**
 * Written on stdin to say the line arrived and is being worked on. It has its own state word so
 * the side waiting on it can leave it alone: a receipt that arrives as an ordinary `say` costs
 * the reader a turn to read the word "收到", and it lands on the very signal they use to decide
 * whether it is their turn to speak.
 */
export const WORKING = "/working";

const LOCAL_POLL_MS = 200;
const RELAY_POLL_MS = 1000;
/** After answering a goodbye the room stays open this long, so the other side can still read it. */
const LINGER_MS = 2000;
/** How long the side that said goodbye first waits for the other one to say it back. */
const BYE_WAIT_MS = 10_000;

export type LineSource = { take(): string[]; ended(): boolean };

export type SessionOptions = {
  code?: string;
  hello?: string;
  lines?: LineSource;
  relay?: string;
  pass?: string;
  home?: string;
  signal?: AbortSignal;
  /** How long a side keeps trying to reach the room before it calls the conversation off. */
  recoverMs?: number;
  /** How long to wait for the other side to say goodbye back. */
  byeWaitMs?: number;
  /** Write attachments the other side sends into the inbox. */
  keepFiles?: boolean;
};

export function lineQueue(): LineSource & { push(text: string): void; end(): void } {
  const pending: string[] = [];
  let closed = false;
  return {
    push(text: string) {
      const trimmed = text.trim();
      if (trimmed) pending.push(trimmed);
    },
    end() {
      closed = true;
    },
    take() {
      return pending.splice(0);
    },
    ended() {
      return closed;
    },
  };
}

export async function runSession(options: SessionOptions): Promise<void> {
  const home = options.home ?? path.join(homedir(), ".agenthop");
  const lines = options.lines ?? stdinLines();
  if (options.code) await joinSession({ ...options, lines }, home);
  else await createSession({ ...options, lines }, home);
}

async function createSession(options: SessionOptions, home: string): Promise<void> {
  const hello = options.hello?.trim() ?? "";
  if (!hello) throw new Error("usage: agenthop <任务背景>");
  let lost = "";
  let peerId: string | undefined;
  // The code is made here rather than in the host, because only this side may hold both halves
  // of it. The host is handed the address alone and never learns the secret.
  const pairingCode = generateCode();
  const { address } = splitCode(pairingCode);
  const box = channel(pairingCode, "create");
  const logFile = () => sessionPath(home, address, "create");
  const host = await startHost({
    code: address,
    relay: options.relay,
    pass: options.pass,
    home,
    keepFiles: options.keepFiles,
    recoverMs: options.recoverMs,
    accept: (text) => {
      // Belonging to this conversation now means holding the secret. Someone who only knows the
      // address cannot produce a line that opens, so this is where they stop.
      let wire: Wire;
      try {
        wire = parseWire(box.open(text).wire);
      } catch {
        return false;
      }
      if (peerId === undefined) {
        if (wire.kind === "connect") peerId = wire.id;
        return true;
      }
      if (wire.kind === "connect") return false;
      return wire.id === peerId;
    },
    onRefused: (reason, text) => {
      const shown = readable(box, text);
      write(logFile(), "peer", "refused", shown ? `${reason}：${shown}` : reason);
    },
    onReconnecting: (reason) => write(logFile(), "local", "reconnecting", `${reason}，正在用同一个配对码把房间接回来`),
    onReconnected: () => write(logFile(), "local", "reconnected", "房间接回来了，对话可以继续"),
    onGone: (reason) => {
      lost = reason;
    },
  });
  const log = logFile();
  // The first line says where the rest of them are, so nobody has to work the path out.
  write(log, "local", "log", log);
  // The whole code, both halves: this line is what the person hands to the other side.
  write(log, "local", "waiting", pairingCode);
  const say = (wire: string) => sayLocal(host, box.seal(wire));
  const out = outbox(options.lines!, log);
  let after = 0;
  let saidBye = 0;
  let phase: "wait-connect" | "wait-confirm" | "ready" = "wait-connect";
  try {
    for (;;) {
      if (options.signal?.aborted) {
        await farewell(say, out, log, phase === "ready" && !saidBye, LINGER_MS, undefined);
        return;
      }
      if (lost) {
        out.reportUnsent();
        if (phase === "wait-connect") {
          write(log, "local", "expired", `没有人用这个配对码加入，房间已经过期（${lost}）。重新执行 agenthop "<任务背景>" 拿一个新配对码。`);
        } else {
          write(log, "peer", "gone", lost);
        }
        return;
      }
      for (const event of await pollLocal(host, after)) {
        after = event.seq;
        if (event.from !== "peer") continue;
        const wire = unseal(box, log, event.text);
        if (!wire) continue;
        noteFiles(log, event, options.keepFiles === true);
        if (wire.kind === "bye") {
          write(log, "peer", "bye", wire.text);
          out.reportUnsent();
          if (saidBye) return;
          await say(byeWire());
          write(log, "local", "bye");
          // The other side reads the room over the relay, so keep it open long enough to be read.
          await delay(LINGER_MS);
          return;
        }
        if (phase === "wait-connect" && wire.kind === "connect") {
          write(log, "peer", "connected");
          await say(helloWire(hello));
          write(log, "local", "hello", hello);
          phase = "wait-confirm";
        } else if (phase === "wait-confirm" && wire.kind === "confirm") {
          write(log, "peer", "confirm", wire.text);
          write(log, "local", "ready");
          phase = "ready";
        } else if (phase === "ready" && wire.kind === "say") {
          write(log, "peer", "say", wire.text);
        } else if (wire.kind === "working") {
          write(log, "peer", "working", wire.text);
        } else if (wire.kind === "other") {
          write(log, "peer", "other", brief(wire.text));
        }
      }
      if (!saidBye && phase === "ready" && (await out.flush(say))) saidBye = Date.now();
      if (saidBye && Date.now() - saidBye > (options.byeWaitMs ?? BYE_WAIT_MS)) {
        write(log, "peer", "gone", "对方没有把告别说回来");
        return;
      }
      await delay(LOCAL_POLL_MS);
    }
  } finally {
    await host.close();
  }
}

async function joinSession(options: SessionOptions, home: string): Promise<void> {
  const code = options.code ?? "";
  // Only the address goes into the room's name and its URLs; the secret stays in this process.
  const { address } = splitCode(code);
  const box = channel(code, "join");
  const log = sessionPath(home, address, "join");
  const id = randomUUID().slice(0, 8);
  const send = (text: string) =>
    sendMessage({ code: address, text: box.seal(text), relay: options.relay, pass: options.pass });
  write(log, "local", "log", log);
  try {
    await send(connectWire(id));
  } catch (error) {
    throw new Error(joinFailure(error));
  }
  write(log, "local", "connected");
  const out = outbox(options.lines!, log);
  const base = roomBase(options.relay, address);
  let after = 0;
  let failingSince = 0;
  let saidBye = 0;
  let phase: "wait-hello" | "wait-confirm" | "ready" = "wait-hello";
  const early: string[] = [];
  for (;;) {
    if (options.signal?.aborted) {
      await farewell(send, out, log, phase === "ready" && !saidBye, 0, id);
      return;
    }
    let events: SessionEvent[];
    try {
      events = (await readQueue(base, after, options.pass)).events;
      if (failingSince) write(log, "local", "reconnected", "又能读到房间了，对话可以继续");
      failingSince = 0;
    } catch {
      if (!failingSince) {
        failingSince = Date.now();
        write(log, "local", "reconnecting", "读不到房间了，正在重试");
      }
      if (Date.now() - failingSince > (options.recoverMs ?? RECOVER_MS)) {
        out.reportUnsent();
        write(log, "peer", "gone", "房间已经不在了，对方可能已经退出，或者房间空闲超过十分钟");
        return;
      }
      await delay(RELAY_POLL_MS);
      continue;
    }
    for (const event of events) {
      after = event.seq;
      if (event.from !== "host") continue;
      const wire = unseal(box, log, event.text);
      if (!wire) continue;
      if (wire.kind === "bye") {
        write(log, "peer", "bye", wire.text);
        out.reportUnsent();
        if (saidBye) return;
        await send(byeWire(id));
        write(log, "local", "bye");
        return;
      }
      if (phase === "wait-hello" && wire.kind === "hello") {
        write(log, "peer", "hello", wire.text);
        phase = "wait-confirm";
      } else if (phase === "ready" && wire.kind === "say") {
        write(log, "peer", "say", wire.text);
      } else if (wire.kind === "working") {
        write(log, "peer", "working", wire.text);
      } else if (wire.kind === "other") {
        write(log, "peer", "other", brief(wire.text));
      }
    }
    const typed = options.lines!.take();
    if (phase === "wait-hello") early.push(...typed);
    else if (phase === "wait-confirm") typed.unshift(...early.splice(0));
    // A receipt written before the channel is open is still a receipt, not the confirmation the
    // creator is waiting for. Send it and keep looking for the line that opens the channel.
    while (phase === "wait-confirm" && isWorking(typed[0] ?? "")) {
      const noted = isWorking(typed.shift() ?? "")!;
      await send(workingWire(id, noted.text));
      write(log, "local", "working", noted.text);
    }
    if (phase === "wait-confirm" && typed.length > 0) {
      const reply = typed.shift() ?? "";
      if (reply === BYE) {
        await send(byeWire(id));
        write(log, "local", "bye");
        saidBye = Date.now();
      } else {
        await send(confirmWire(id, reply));
        write(log, "local", "confirm", reply);
        write(log, "local", "ready");
        phase = "ready";
      }
    }
    if (!saidBye && phase === "ready" && (await out.flush((wire) => send(wire), typed, id))) saidBye = Date.now();
    if (saidBye && Date.now() - saidBye > (options.byeWaitMs ?? BYE_WAIT_MS)) {
      write(log, "peer", "gone", "对方没有把告别说回来");
      return;
    }
    await delay(RELAY_POLL_MS);
  }
}

type Outbox = {
  flush(send: (wire: string) => Promise<unknown>, queued?: string[], id?: string): Promise<boolean>;
  reportUnsent(): void;
};

/**
 * Turns stdin lines into what goes out. A line that cannot be sent is written down as
 * `undelivered` instead of disappearing, so nobody believes they answered when they did not.
 */
function outbox(lines: LineSource, logFile: string): Outbox {
  let noted = false;
  return {
    async flush(send, queued, id) {
      const texts = [...(queued ?? []), ...lines.take()];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i] ?? "";
        const bye = text === BYE;
        const working = !bye && isWorking(text);
        try {
          if (bye) await send(byeWire(id));
          else if (working) await send(workingWire(id, working.text));
          else await send(sayWire(id, text));
        } catch {
          for (const missed of texts.slice(i)) write(logFile, "local", "undelivered", missed);
          return false;
        }
        if (bye) write(logFile, "local", "bye");
        else if (working) write(logFile, "local", "working", working.text);
        else write(logFile, "local", "say", text);
        if (bye) return true;
      }
      if (lines.ended() && !noted) {
        noted = true;
        write(logFile, "local", "input-closed", `标准输入已关闭，这一方只能收听。要结束对话，写一行 ${BYE}`);
      }
      return false;
    },
    reportUnsent() {
      for (const text of lines.take()) write(logFile, "local", "undelivered", text);
    },
  };
}

/** Ctrl-C still owes the other side a goodbye. */
async function farewell(
  send: (wire: string) => Promise<unknown>,
  out: Outbox,
  logFile: string,
  owed: boolean,
  linger: number,
  // The joining side signs its lines, and an unsigned goodbye is one the creator turns away —
  // so a Ctrl-C used to leave the other side waiting out the clock for a bye that was sent.
  id: string | undefined,
): Promise<void> {
  out.reportUnsent();
  if (!owed) return;
  try {
    await send(byeWire(id));
    write(logFile, "local", "bye");
    if (linger) await delay(linger);
  } catch {
    write(logFile, "local", "undelivered", BYE);
  }
}

/**
 * Open one incoming line. Every way of turning one away writes a line saying so — a conversation
 * that quietly loses a sentence is worse than one that says it lost it.
 */
function unseal(box: Channel, logFile: string, text: string): Wire | undefined {
  let opened: { counter: number; wire: string };
  try {
    opened = box.open(text);
  } catch {
    write(logFile, "peer", "refused", `这一句解不开（密钥不对或被篡改）：${brief(text)}`);
    return undefined;
  }
  // The relay carries these lines and could hand one over twice, putting an old answer under a
  // new question. Counters only ever go up; a gap is a send that failed, a repeat is a replay.
  if (!box.fresh(opened.counter)) {
    write(logFile, "peer", "refused", `重复的消息，已经忽略（可能是中继重放）：${brief(opened.wire)}`);
    return undefined;
  }
  const wire = parseWire(opened.wire);
  if (wire.kind === "sealed") {
    write(logFile, "peer", "refused", "一层里面还是一层，已经忽略");
    return undefined;
  }
  return wire;
}

/** What a line the room turned away should look like in the log, when it can be read at all. */
function readable(box: Channel, text: string): string {
  if (!text) return "";
  try {
    return brief(box.open(text).wire);
  } catch {
    return "（无法解密）";
  }
}

/**
 * What a refused or unreadable line looks like in the log. Only the conversation itself is
 * written out in full: anyone holding the code can post, and a log line is one line.
 */
export function brief(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…（共 ${flat.length} 字）`;
}

/** Attachments are not written to disk unless the person asked for that, so say what arrived. */
function noteFiles(logFile: string, event: SessionEvent, kept: boolean): void {
  if (event.files.length === 0) return;
  const names = event.files.map((file) => file.name).join(" ");
  if (kept) write(logFile, "peer", "files", event.files.map((file) => file.path).join(" "));
  else write(logFile, "peer", "files", `对方带了 ${event.files.length} 个文件，没有保存（要保存加 --accept-files）：${names}`);
}

async function sayLocal(host: RunningHost, text: string): Promise<void> {
  const response = await fetch(`${host.controlUrl}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), text }),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function pollLocal(host: RunningHost, after: number): Promise<SessionEvent[]> {
  const response = await fetch(`${host.controlUrl}/queue?after=${after}`);
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as { events: SessionEvent[] }).events;
}

function joinFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `加入房间失败。配对码可能打错了，或者房间已经过期（十分钟没有对话就会消失）。请对方重新执行 agenthop "<任务背景>" 拿一个新配对码。\n${detail}`;
}

export type Seat = "create" | "join";

/**
 * A log is one end's view of one conversation, so both are in its name. On one machine the two
 * sides share a home directory, and keying only by the code put them in the same file.
 */
export function sessionPath(home: string, code: string, seat: Seat): string {
  return path.join(home, "sessions", `${code}.${seat}.log`);
}

export function write(file: string, side: "local" | "peer", state: string, text = ""): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = `${stamp()} ${side} ${state}${text ? ` ${text}` : ""}`;
  appendFileSync(file, `${line}\n`);
  writeSync(1, `${line}\n`);
  return line;
}

/** Local time with its offset. A log is read by the person sitting in front of it. */
export function stamp(now = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const size = Math.abs(offset);
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${day}T${clock}${sign}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
}

export type Wire = {
  kind: "connect" | "hello" | "confirm" | "say" | "working" | "bye" | "sealed" | "other";
  id: string;
  text: string;
};

/** `/working` on its own, or with the rest of the line as what is being worked on. */
function isWorking(text: string): { text: string } | undefined {
  if (text === WORKING) return { text: "" };
  if (text.startsWith(`${WORKING} `)) return { text: text.slice(WORKING.length + 1).trim() };
  return undefined;
}

/**
 * The joining side stamps every line with the id it made up when it connected, so a third
 * person holding the same code cannot be mistaken for the peer. The id travels inside the seal,
 * which is what makes it worth checking: forging one means holding the secret.
 */
const KINDS = new Set(["connect", "hello", "confirm", "say", "working", "bye", "sealed"]);

export function parseWire(text: string): Wire {
  const match = text.match(/^\[\[agenthop:([a-z]+)(?::([A-Za-z0-9-]+))?]] ?([\s\S]*)$/);
  if (!match) return { kind: "other", id: "", text };
  const name = match[1] ?? "";
  // A well-formed line in a form this version does not know is something a newer version on the
  // other side added. Keeping its id lets it be written down as `other` rather than turned away
  // as a stranger's — the whole line is kept, so the log says which form it was.
  if (!KINDS.has(name)) return { kind: "other", id: match[2] ?? "", text };
  return { kind: name as Wire["kind"], id: match[2] ?? "", text: match[3] ?? "" };
}

function wire(kind: string, id: string | undefined, text: string): string {
  return `[[agenthop:${kind}${id ? `:${id}` : ""}]]${text ? ` ${text}` : ""}`;
}

function connectWire(id: string): string {
  return wire("connect", id, "");
}

function helloWire(text: string): string {
  return wire("hello", undefined, text);
}

function confirmWire(id: string, text: string): string {
  return wire("confirm", id, text);
}

export function sayWire(id: string | undefined, text: string): string {
  return wire("say", id, text);
}

function workingWire(id: string | undefined, text: string): string {
  return wire("working", id, text);
}

function byeWire(id?: string): string {
  return wire("bye", id, "");
}

function stdinLines(): LineSource {
  const pending: string[] = [];
  const input = process.stdin;
  let closed = false;
  let rest = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    rest += chunk;
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? "";
    for (const part of parts) {
      const text = part.trim();
      if (text) pending.push(text);
    }
  });
  // Reading from stdin must not be the reason this process stays alive once the conversation ends.
  input.unref?.();
  input.on("end", () => {
    const text = rest.trim();
    if (text) pending.push(text);
    rest = "";
    closed = true;
  });
  return { take: () => pending.splice(0), ended: () => closed };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
