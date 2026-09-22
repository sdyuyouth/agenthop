import { startRelay } from "@agenthop/relay-node";
import { sendMessage } from "./send.js";
import { readHostFile, startHost } from "./host.js";

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "host") {
    const flags = flagsOf(rest);
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
    const flags = flagsOf(rest);
    const id = rest.find((arg) => !arg.startsWith("--"));
    const text = flags.text ?? rest.filter((arg) => !arg.startsWith("--") && arg !== id).join(" ");
    if (!id || (!text && flags.files.length === 0)) throw new Error("usage: agenthop reply <id> <text> [--file PATH]");
    const host = await readHostFile();
    const response = await fetch(`${host.controlUrl}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, text, files: flags.files }),
    });
    if (!response.ok) throw new Error(await response.text());
  } else if (command === "send") {
    const flags = flagsOf(rest);
    const code = rest.find((arg) => !arg.startsWith("--"));
    const text = flags.text ?? rest.filter((arg) => !arg.startsWith("--") && arg !== code).join(" ");
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
  } else if (command === "relay") {
    const flags = flagsOf(rest);
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
    console.log("usage: agenthop host [--json] [--relay URL] [--pass SECRET]");
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

function flagsOf(args: string[]): Flags {
  const flags: Flags = { files: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") flags.json = true;
    if (arg === "--relay") flags.relay = args[++i];
    if (arg === "--pass") flags.pass = args[++i];
    if (arg === "--listen") flags.listen = args[++i];
    if (arg === "--text") flags.text = args[++i];
    if (arg === "--out") flags.out = args[++i];
    if (arg === "--file") flags.files.push(args[++i] ?? "");
  }
  return flags;
}
