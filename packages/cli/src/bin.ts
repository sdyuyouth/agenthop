import { startRelay } from "@agenthop/relay-node";
import { sendMessage } from "./send.js";
import { startHost } from "./host.js";

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "host") {
    const flags = flagsOf(rest);
    const running = await startHost({ dir: flags.dir, relay: flags.relay, pass: flags.pass });
    if (flags.json) {
      console.log(JSON.stringify({ code: running.code, url: running.url }));
    } else {
      console.log(`code ${running.code}`);
      console.log(`url  ${running.url}`);
    }
    process.on("SIGINT", () => {
      void running.close().then(() => process.exit(0));
    });
  } else if (command === "send") {
    const code = rest.find((arg) => !arg.startsWith("--"));
    const text = rest.filter((arg) => !arg.startsWith("--") && arg !== code).join(" ");
    const flags = flagsOf(rest);
    if (!code || !text) throw new Error("usage: agenthop send <code> <text>");
    const reply = await sendMessage({ code, text, relay: flags.relay, pass: flags.pass, stream: flags.stream });
    console.log(reply);
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
    console.log("usage: agenthop host [--dir PATH] [--json] [--relay URL] [--pass SECRET]");
    console.log("       agenthop send <code> <text> [--relay URL] [--pass SECRET] [--stream]");
    console.log("       agenthop relay [--listen HOST:PORT] [--pass SECRET]");
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function flagsOf(args: string[]): { dir?: string; relay?: string; pass?: string; listen?: string; stream: boolean; json: boolean } {
  const flags: { dir?: string; relay?: string; pass?: string; listen?: string; stream: boolean; json: boolean } = {
    stream: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stream") flags.stream = true;
    if (arg === "--json") flags.json = true;
    if (arg === "--dir") flags.dir = args[++i];
    if (arg === "--relay") flags.relay = args[++i];
    if (arg === "--pass") flags.pass = args[++i];
    if (arg === "--listen") flags.listen = args[++i];
  }
  return flags;
}
