import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { relayEndpoints } from "@agenthop/tunnel";
import { DEFAULT_RELAY, startHost, type RunningHost } from "./host.js";
import { readQueue, sendMessage } from "./send.js";
import { type SessionEvent } from "./talk.js";

const CONNECT = "[[agenthop:connect]]";

export type LineSource = { take(): string[] };

export type SessionOptions = {
  code?: string;
  hello?: string;
  lines?: LineSource;
  relay?: string;
  pass?: string;
  home?: string;
  signal?: AbortSignal;
};

export function lineQueue(): LineSource & { push(text: string): void } {
  const pending: string[] = [];
  return {
    push(text: string) {
      const trimmed = text.trim();
      if (trimmed) pending.push(trimmed);
    },
    take() {
      return pending.splice(0);
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
  const host = await startHost({ relay: options.relay, pass: options.pass, home });
  const logFile = sessionPath(home, host.code);
  write(logFile, "local", "waiting", host.code);
  let after = 0;
  let phase: "wait-connect" | "wait-confirm" | "ready" = "wait-connect";
  try {
    while (!options.signal?.aborted) {
      const events = await pollLocal(host, after);
      for (const event of events) {
        after = event.seq;
        if (event.from !== "peer") continue;
        const wire = parseWire(event.text);
        if (phase === "wait-connect" && wire.kind === "connect") {
          write(logFile, "local", "connected");
          await sayLocal(host, helloWire(hello));
          write(logFile, "local", "hello", hello);
          phase = "wait-confirm";
        } else if (phase === "wait-confirm" && wire.kind === "confirm") {
          write(logFile, "peer", "confirm", wire.text);
          write(logFile, "local", "ready");
          phase = "ready";
        } else if (phase === "ready" && wire.kind === "say") {
          write(logFile, "peer", "say", wire.text);
        }
      }
      if (phase === "ready") await flushSays(options.lines!, (text) => sayLocal(host, text), logFile);
      await delay(200);
    }
  } finally {
    await host.close();
  }
}

async function joinSession(options: SessionOptions, home: string): Promise<void> {
  const code = options.code ?? "";
  const logFile = sessionPath(home, code);
  write(logFile, "local", "connected");
  await sendMessage({ code, text: CONNECT, relay: options.relay, pass: options.pass });
  let after = 0;
  let phase: "wait-hello" | "wait-confirm" | "ready" = "wait-hello";
  const early: string[] = [];
  while (!options.signal?.aborted) {
    const body = await readQueue(queueBase(options.relay, code), after, options.pass);
    for (const event of body.events) {
      after = event.seq;
      if (event.from !== "host") continue;
      const wire = parseWire(event.text);
      if (phase === "wait-hello" && wire.kind === "hello") {
        write(logFile, "peer", "hello", wire.text);
        phase = "wait-confirm";
      } else if (phase === "ready" && wire.kind === "say") {
        write(logFile, "peer", "say", wire.text);
      }
    }
    const typed = options.lines!.take();
    if (phase === "wait-hello") early.push(...typed);
    else if (phase === "wait-confirm") typed.unshift(...early.splice(0));
    if (phase === "wait-confirm" && typed.length > 0) {
      const reply = typed.shift() ?? "";
      await sendMessage({ code, text: confirmWire(reply), relay: options.relay, pass: options.pass });
      write(logFile, "local", "confirm", reply);
      write(logFile, "local", "ready");
      phase = "ready";
    }
    if (phase === "ready") {
      for (const text of typed) await sendOut(code, text, options, logFile);
    }
    await delay(200);
  }
}

async function flushSays(lines: LineSource, send: (wire: string) => Promise<void>, logFile: string): Promise<void> {
  for (const text of lines.take()) {
    await send(sayWire(text));
    write(logFile, "local", "say", text);
  }
}

async function sendOut(code: string, text: string, options: SessionOptions, logFile: string): Promise<void> {
  await sendMessage({ code, text: sayWire(text), relay: options.relay, pass: options.pass });
  write(logFile, "local", "say", text);
}

async function sayLocal(host: RunningHost, text: string): Promise<void> {
  const response = await fetch(`${host.controlUrl}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), kind: "say", text, files: [] }),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function pollLocal(host: RunningHost, after: number): Promise<SessionEvent[]> {
  const response = await fetch(`${host.controlUrl}/queue?after=${after}`);
  if (!response.ok) throw new Error(await response.text());
  const body = (await response.json()) as { events: SessionEvent[] };
  return body.events;
}

function queueBase(relay: string | undefined, code: string): string {
  return relayEndpoints(relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY, code).publicBase;
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

export function parseWire(text: string): { kind: "connect" | "hello" | "confirm" | "say" | "other"; text: string } {
  if (text === CONNECT) return { kind: "connect", text: "" };
  const hello = text.match(/^\[\[agenthop:hello]] ([\s\S]*)$/);
  if (hello) return { kind: "hello", text: hello[1] ?? "" };
  const confirm = text.match(/^\[\[agenthop:confirm]] ([\s\S]*)$/);
  if (confirm) return { kind: "confirm", text: confirm[1] ?? "" };
  const say = text.match(/^\[\[agenthop:say]] ([\s\S]*)$/);
  if (say) return { kind: "say", text: say[1] ?? "" };
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

function stdinLines(): LineSource {
  const pending: string[] = [];
  const input = process.stdin;
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
  return { take: () => pending.splice(0) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
