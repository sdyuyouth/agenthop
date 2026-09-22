import { writeSync } from "node:fs";
import { startRelay } from "@agenthop/relay-node";
import { isValidCode, normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { installAgenthop } from "./install.js";
import { DEFAULT_RELAY, readHostFile, startHost } from "./host.js";
import { followRoom, readQueue, sendMessage, type SendKind } from "./send.js";
import { type SessionEvent } from "./talk.js";

const [command, ...rest] = process.argv.slice(2);
const parsed = parseArgs(rest);
const flags = parsed.flags;
const positionals = parsed.positionals;

try {
  if (command === "host") {
    const running = await startHost({
      relay: flags.relay,
      pass: flags.pass,
      onReceive: flags.onReceive,
      onEvent: (event) => printEvent(event, flags.json),
    });
    if (flags.json) {
      writeLine(JSON.stringify({ at: new Date().toISOString(), code: running.code, url: running.url }));
    } else {
      writeLine(`${new Date().toISOString()} code ${running.code}`);
      writeLine(`${new Date().toISOString()} url  ${running.url}`);
    }
    process.on("SIGINT", () => {
      void running.close().then(() => process.exit(0));
    });
  } else if (command === "join") {
    const code = positionals[0];
    if (!code) throw new Error("usage: agenthop join <code>");
    process.on("SIGINT", () => process.exit(0));
    await followRoom({
      code,
      relay: flags.relay,
      pass: flags.pass,
      onReceive: flags.onReceive,
      onEvent: (event) => printEvent(event, flags.json),
    });
  } else if (command === "queue" || command === "inbox") {
    const code = positionals[0];
    if (code) {
      const relay = flags.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
      console.log(JSON.stringify(await readQueue(relayEndpoints(relay, normalizeCode(code)).publicBase, 0, flags.pass)));
    } else {
      const host = await readHostFile();
      const response = await fetch(`${host.controlUrl}/queue`);
      if (!response.ok) throw new Error(await response.text());
      console.log(await response.text());
    }
  } else if (command === "reply" || command === "send") {
    const kind = kindOf(flags, command);
    const parsedSend = splitSend(positionals, command);
    if (!parsedSend.text && flags.files.length === 0) throw new Error(sendUsage());
    const result = await sendMessage({
      code: parsedSend.code,
      text: flags.text ?? parsedSend.text,
      files: flags.files,
      relay: flags.relay,
      pass: flags.pass,
      outDir: flags.out,
      kind,
      answerId: command === "reply" ? positionals[0] : flags.answer,
    });
    if (flags.json || result.event !== "done") {
      console.log(JSON.stringify(result));
    } else {
      if (result.text) console.log(result.text);
      for (const file of result.files) console.error(`file ${file.path}`);
    }
  } else if (command === "install") {
    installAgenthop({ skillDirs: flags.skillDirs });
  } else if (command === "relay") {
    const [host, portText] = (flags.listen ?? "127.0.0.1:8787").split(":");
    const running = await startRelay({
      listenHost: host,
      listenPort: portText ? Number(portText) : undefined,
      pass: flags.pass,
    });
    console.log(running.url);
    process.on("SIGINT", () => {
      void running.close().then(() => process.exit(0));
    });
  } else {
    console.log("usage: agenthop install [--skill-dir DIR]");
    console.log("       agenthop host [--json] [--relay URL] [--pass SECRET] [--on-receive CMD]");
    console.log("       agenthop join <code> [--json] [--relay URL] [--on-receive CMD]");
    console.log("       agenthop queue [code]");
    console.log("       agenthop send [code] <text> [--ask] [--answer ID] [--supplement] [--file PATH] [--json]");
    console.log("       agenthop relay [--listen HOST:PORT] [--pass SECRET]");
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function printEvent(event: SessionEvent, json: boolean): void {
  if (json) {
    writeLine(JSON.stringify(event));
    return;
  }
  writeLine(`${event.at} ${event.from} ${event.event} ${event.id}`);
  if (event.text) writeLine(event.text);
  for (const file of event.files) writeLine(`file ${file.path}`);
  if (event.pending.length > 0) writeLine(`pending ${event.pending.join(" ")}`);
}

function writeLine(line: string): void {
  writeSync(1, `${line}\n`);
}

function kindOf(flags: Flags, command: string): SendKind {
  const chosen = [flags.ask, Boolean(flags.answer) || command === "reply", flags.supplement].filter(Boolean).length;
  if (chosen > 1) throw new Error(sendUsage());
  if (flags.ask) return "ask";
  if (flags.answer || command === "reply") return "result";
  if (flags.supplement) return "supplement";
  return "say";
}

function splitSend(positionals: string[], command: string): { code?: string; text: string } {
  if (command === "reply") {
    const id = positionals[0];
    if (!id) throw new Error(sendUsage());
    return { text: positionals.slice(1).join(" ") };
  }
  const head = positionals[0];
  if (head && isValidCode(head)) return { code: head, text: positionals.slice(1).join(" ") };
  return { text: positionals.join(" ") };
}

function sendUsage(): string {
  return "usage: agenthop send [code] <text> [--ask] [--answer ID] [--supplement] [--file PATH]";
}

type Flags = {
  relay?: string;
  pass?: string;
  listen?: string;
  text?: string;
  out?: string;
  files: string[];
  skillDirs: string[];
  answer?: string;
  ask: boolean;
  supplement: boolean;
  onReceive?: string;
  json: boolean;
};

function parseArgs(args: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = { files: [], skillDirs: [], ask: false, supplement: false, json: false };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--relay") flags.relay = args[++i];
    else if (arg === "--pass") flags.pass = args[++i];
    else if (arg === "--listen") flags.listen = args[++i];
    else if (arg === "--text") flags.text = args[++i];
    else if (arg === "--out") flags.out = args[++i];
    else if (arg === "--file") flags.files.push(args[++i] ?? "");
    else if (arg === "--ask") flags.ask = true;
    else if (arg === "--supplement") flags.supplement = true;
    else if (arg === "--answer") flags.answer = args[++i];
    else if (arg === "--on-receive") flags.onReceive = args[++i];
    else if (arg === "--skill-dir") flags.skillDirs.push(args[++i] ?? "");
    else positionals.push(arg ?? "");
  }
  return { flags, positionals };
}
