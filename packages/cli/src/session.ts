import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readQueue, roomBase, sendMessage } from "./send.js";
import { startHost, type RunningHost } from "./host.js";
import { type SessionEvent } from "./talk.js";

const CONNECT = "[[agenthop:connect]]";
/** Written on stdin to end the conversation on purpose. */
export const BYE = "/bye";

/** How long the joining side keeps retrying the relay before it calls the room gone. */
const GONE_AFTER_MS = 15_000;
const LOCAL_POLL_MS = 200;
const RELAY_POLL_MS = 1000;
/** After saying goodbye the room stays open this long, so the other side can still read the line. */
const LINGER_MS = 2000;

export type LineSource = { take(): string[]; ended(): boolean };

export type SessionOptions = {
  code?: string;
  hello?: string;
  lines?: LineSource;
  relay?: string;
  pass?: string;
  home?: string;
  signal?: AbortSignal;
  /** How long the joining side retries a failing relay before it writes `peer gone`. */
  goneAfterMs?: number;
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
  let gone = "";
  const host = await startHost({
    relay: options.relay,
    pass: options.pass,
    home,
    onGone: (reason) => {
      gone = reason;
    },
  });
  const logFile = sessionPath(home, host.code);
  write(logFile, "local", "waiting", host.code);
  const out = outbox(options.lines!, logFile);
  let after = 0;
  let phase: "wait-connect" | "wait-confirm" | "ready" = "wait-connect";
  try {
    while (!options.signal?.aborted) {
      if (gone) {
        write(logFile, "peer", "gone", gone);
        return;
      }
      for (const event of await pollLocal(host, after)) {
        after = event.seq;
        if (event.from !== "peer") continue;
        const wire = parseWire(event.text);
        if (wire.kind === "bye") {
          write(logFile, "peer", "bye", wire.text);
          return;
        }
        if (phase === "wait-connect" && wire.kind === "connect") {
          write(logFile, "peer", "connected");
          await sayLocal(host, helloWire(hello));
          write(logFile, "local", "hello", hello);
          phase = "wait-confirm";
        } else if (phase === "wait-confirm" && wire.kind === "confirm") {
          write(logFile, "peer", "confirm", wire.text);
          write(logFile, "local", "ready");
          phase = "ready";
        } else if (phase === "ready" && wire.kind === "say") {
          write(logFile, "peer", "say", wire.text);
        } else if (wire.kind === "other") {
          write(logFile, "peer", "other", wire.text);
        }
      }
      if (phase === "ready" && (await out.flush((text) => sayLocal(host, text)))) {
        await delay(LINGER_MS);
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
  const logFile = sessionPath(home, code);
  const send = (text: string) => sendMessage({ code, text, relay: options.relay, pass: options.pass });
  try {
    await send(CONNECT);
  } catch (error) {
    throw new Error(joinFailure(error));
  }
  write(logFile, "local", "connected");
  const out = outbox(options.lines!, logFile);
  const base = roomBase(options.relay, code);
  let after = 0;
  let failingSince = 0;
  let phase: "wait-hello" | "wait-confirm" | "ready" = "wait-hello";
  const early: string[] = [];
  while (!options.signal?.aborted) {
    let events: SessionEvent[];
    try {
      events = (await readQueue(base, after, options.pass)).events;
      failingSince = 0;
    } catch {
      failingSince = failingSince || Date.now();
      if (Date.now() - failingSince > (options.goneAfterMs ?? GONE_AFTER_MS)) {
        write(logFile, "peer", "gone", "房间已经不在了，对方可能已经退出，或者房间空闲超过十分钟");
        return;
      }
      await delay(RELAY_POLL_MS);
      continue;
    }
    for (const event of events) {
      after = event.seq;
      if (event.from !== "host") continue;
      const wire = parseWire(event.text);
      if (wire.kind === "bye") {
        write(logFile, "peer", "bye", wire.text);
        return;
      }
      if (phase === "wait-hello" && wire.kind === "hello") {
        write(logFile, "peer", "hello", wire.text);
        phase = "wait-confirm";
      } else if (phase === "ready" && wire.kind === "say") {
        write(logFile, "peer", "say", wire.text);
      } else if (wire.kind === "other") {
        write(logFile, "peer", "other", wire.text);
      }
    }
    const typed = options.lines!.take();
    if (phase === "wait-hello") early.push(...typed);
    else if (phase === "wait-confirm") typed.unshift(...early.splice(0));
    if (phase === "wait-confirm" && typed.length > 0) {
      const reply = typed.shift() ?? "";
      if (reply === BYE) {
        await send(byeWire());
        write(logFile, "local", "bye");
        return;
      }
      await send(confirmWire(reply));
      write(logFile, "local", "confirm", reply);
      write(logFile, "local", "ready");
      phase = "ready";
    }
    if (phase === "ready" && (await out.flush(send, typed))) return;
    await delay(RELAY_POLL_MS);
  }
}

/** Turns stdin lines into what goes out. Returns true once this side has said goodbye. */
function outbox(lines: LineSource, logFile: string): { flush(send: (wire: string) => Promise<unknown>, queued?: string[]): Promise<boolean> } {
  let noted = false;
  return {
    async flush(send, queued) {
      for (const text of [...(queued ?? []), ...lines.take()]) {
        if (text === BYE) {
          await send(byeWire());
          write(logFile, "local", "bye");
          return true;
        }
        await send(sayWire(text));
        write(logFile, "local", "say", text);
      }
      if (lines.ended() && !noted) {
        noted = true;
        write(logFile, "local", "input-closed", `标准输入已关闭，这一方只能收听。要结束对话，写一行 ${BYE}`);
      }
      return false;
    },
  };
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

export function sessionPath(home: string, code: string): string {
  return path.join(home, "sessions", `${code}.log`);
}

export function write(file: string, side: "local" | "peer", state: string, text = ""): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = `${new Date().toISOString()} ${side} ${state}${text ? ` ${text}` : ""}`;
  appendFileSync(file, `${line}\n`);
  writeSync(1, `${line}\n`);
  return line;
}

export function parseWire(text: string): { kind: "connect" | "hello" | "confirm" | "say" | "bye" | "other"; text: string } {
  if (text === CONNECT) return { kind: "connect", text: "" };
  const match = text.match(/^\[\[agenthop:(hello|confirm|say|bye)]] ?([\s\S]*)$/);
  if (match) return { kind: match[1] as "hello" | "confirm" | "say" | "bye", text: match[2] ?? "" };
  return { kind: "other", text };
}

function helloWire(text: string): string {
  return `[[agenthop:hello]] ${text}`;
}

function confirmWire(text: string): string {
  return `[[agenthop:confirm]] ${text}`;
}

export function sayWire(text: string): string {
  return `[[agenthop:say]] ${text}`;
}

function byeWire(): string {
  return "[[agenthop:bye]]";
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
