import { writeSync } from "node:fs";
import { startRelay } from "@agenthop/relay-node";
import { isValidCode, normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { installAgenthop } from "./install.js";
import { updateAgenthop } from "./update.js";
import { DEFAULT_RELAY, readHostFile, startHost } from "./host.js";
import { followRoom, readQueue, sendMessage, type SendKind } from "./send.js";
import { runSession } from "./session.js";
import { type SessionEvent } from "./talk.js";

const parsed = parseArgs(process.argv.slice(2));
const flags = parsed.flags;
const positionals = parsed.positionals;
const command = positionals[0] ?? "";
const words = positionals.slice(1);

try {
  if (flags.agent) {
    const code = command && isValidCode(command) ? command : undefined;
    await runSession({
      code,
      hello: code ? words.join(" ") : positionals.join(" "),
      agent: flags.agent,
      relay: flags.relay,
      pass: flags.pass,
    });
  } else if (command === "host") {
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
  } else if (command === "join" || command === "watch") {
    const code = words[0];
    if (!code) throw new Error("usage: agenthop watch <code> [--on-receive CMD]");
    process.on("SIGINT", () => process.exit(0));
    await followRoom({
      code,
      relay: flags.relay,
      pass: flags.pass,
      onReceive: flags.onReceive,
      onEvent: (event) => printEvent(event, flags.json),
    });
  } else if (command === "queue" || command === "inbox") {
    const code = words[0];
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
    const parsedSend = splitSend(words, command);
    if (!parsedSend.text && flags.files.length === 0) throw new Error(sendUsage());
    const result = await sendMessage({
      code: parsedSend.code,
      text: flags.text ?? parsedSend.text,
      files: flags.files,
      relay: flags.relay,
      pass: flags.pass,
      outDir: flags.out,
      kind,
      answerId: command === "reply" ? words[0] : flags.answer,
    });
    if (flags.json || result.event !== "done") {
      console.log(JSON.stringify(result));
    } else {
      if (result.text) console.log(result.text);
      for (const file of result.files) console.error(`file ${file.path}`);
    }
  } else if (command === "install") {
    installAgenthop({ skillDirs: flags.skillDirs });
  } else if (command === "update" || command === "upgrade" || command === "self-update") {
    await updateAgenthop({ check: flags.check, force: flags.force });
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
  } else if (flags.help || command === "help" || command === "") {
    printHelp();
  } else {
    printHelp();
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function printHelp(): void {
  const lines = [
    "对话",
    "  agenthop --agent <命令> <任务背景>",
    "  agenthop <配对码> --agent <命令>",
    "  没有配对码就创建房间，并写出配对码。任务背景作为 hello 发给加入方。",
    "  有配对码就加入。加入方的命令读到 hello，自己判断是否和当前上下文相符。",
    "  相符：标准输出写下确认，退出码 0。创建方收到后通道才 ready。",
    "  不相符：询问用户，不写确认。通道不就绪。",
    "  ready 之后，只有对方新的一句会再启动命令。本方自己写出的行不会。",
    "  标准输入是日志中的那一行。标准输出有正文且退出码为 0 才送出下一句。",
    "  日志：<家目录>/.agenthop/sessions/<配对码>.log",
    "  每行：<时间> <local|peer> <状态> <正文>",
    "  状态：waiting connected hello confirm ready say",
    "",
    "安装",
    "  下载 https://github.com/sdyuyouth/agenthop/releases/latest",
    "  macOS Apple 芯片    agenthop-macos-arm64",
    "  macOS Intel         agenthop-macos-x64",
    "  Linux x64           agenthop-linux-x64",
    "  Linux ARM64         agenthop-linux-arm64",
    "  Windows 64 位       agenthop-windows-x64.exe",
    "  没有 Windows ARM 包。",
    "  macOS / Linux：chmod +x <文件>，再执行 <文件> install --skill-dir <技能目录>",
    "  命令装到 ~/.local/bin/agenthop。新开的终端才能直接用 agenthop。",
    "  Windows PowerShell：.\\agenthop-windows-x64.exe install --skill-dir <技能目录>",
    "  命令装到 %LOCALAPPDATA%\\agenthop\\agenthop.exe，并写入用户 PATH。新开的终端才能直接用 agenthop。",
    "  --skill-dir 可重复。每个目录写入一份 SKILL.md。另外总会写到 <家目录>/.agenthop/SKILL.md。",
    "  Windows 的家目录是 %USERPROFILE%。",
    "",
    "更新",
    "  agenthop update",
    "  agenthop update --check     只查询，不安装",
    "  agenthop update --force     版本相同也重新安装",
    "  upgrade 与 self-update 相同。",
    "  v0.1.6 之前的程序没有 update，需要先换一次当前发布的文件。",
    "",
    "中继",
    "  默认 https://agenthop.imatrix.tech",
    "  --relay URL 或环境变量 AGENTHOP_RELAY",
    "  自建时两边都加 --pass SECRET",
    "  agenthop relay [--listen HOST:PORT] [--pass SECRET]",
    "",
    "  agenthop help",
  ];
  for (const line of lines) writeLine(line);
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
  agent?: string;
  check: boolean;
  force: boolean;
  help: boolean;
  json: boolean;
};

function parseArgs(args: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = { files: [], skillDirs: [], ask: false, supplement: false, check: false, force: false, help: false, json: false };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
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
    else if (arg === "--agent") flags.agent = args[++i];
    else if (arg === "--check") flags.check = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--skill-dir") flags.skillDirs.push(args[++i] ?? "");
    else positionals.push(arg ?? "");
  }
  return { flags, positionals };
}
