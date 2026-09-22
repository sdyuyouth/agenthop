import { startRelay } from "@agenthop/relay-node";
import { installAgenthop } from "./install.js";
import { sendMessage } from "./send.js";
import { readHostFile, startHost } from "./host.js";

const [command, ...rest] = process.argv.slice(2);
const parsed = parseArgs(rest);
const flags = parsed.flags;
const positionals = parsed.positionals;

try {
  if (command === "host") {
    const running = await startHost({ relay: flags.relay, pass: flags.pass });
    if (flags.json) {
      console.log(JSON.stringify({ code: running.code, url: running.url }));
    } else {
      console.log(`code ${running.code}`);
      console.log(`url  ${running.url}`);
    }
    process.on("SIGINT", () => {
      void running.close().then(() => process.exit(0));
    });
  } else if (command === "inbox") {
    const host = await readHostFile();
    const response = await fetch(`${host.controlUrl}/inbox`);
    if (!response.ok) throw new Error(await response.text());
    console.log(await response.text());
  } else if (command === "reply") {
    const id = positionals[0];
    const text = flags.text ?? positionals.slice(1).join(" ");
    if (!id || (!text && flags.files.length === 0)) throw new Error("usage: agenthop reply <id> <text> [--file PATH]");
    const host = await readHostFile();
    const response = await fetch(`${host.controlUrl}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, text, files: flags.files }),
    });
    if (!response.ok) throw new Error(await response.text());
  } else if (command === "send") {
    const code = positionals[0];
    const text = flags.text ?? positionals.slice(1).join(" ");
    if (!code || (!text && flags.files.length === 0)) throw new Error("usage: agenthop send <code> <text> [--file PATH]");
    const result = await sendMessage({
      code,
      text,
      files: flags.files,
      relay: flags.relay,
      pass: flags.pass,
      outDir: flags.out,
    });
    if (flags.json) {
      console.log(JSON.stringify(result));
    } else {
      if (result.text) console.log(result.text);
      for (const file of result.files) console.error(`file ${file.path}`);
    }
  } else if (command === "install") {
    installAgenthop();
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
    console.log("usage: agenthop install");
    console.log("       agenthop host [--json] [--relay URL] [--pass SECRET]");
    console.log("       agenthop inbox");
    console.log("       agenthop reply <id> <text> [--file PATH]");
    console.log("       agenthop send <code> <text> [--file PATH] [--out DIR] [--json]");
    console.log("       agenthop relay [--listen HOST:PORT] [--pass SECRET]");
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

type Flags = {
  relay?: string;
  pass?: string;
  listen?: string;
  text?: string;
  out?: string;
  files: string[];
  json: boolean;
};

function parseArgs(args: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = { files: [], json: false };
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
    else positionals.push(arg ?? "");
  }
  return { flags, positionals };
}
