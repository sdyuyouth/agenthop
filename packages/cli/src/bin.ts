import { writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { startRelay } from "@agenthop/relay-node";
import { classifyInput, parseArgs } from "./args.js";
import { fingerprint, forgetContact, loadContacts, loadIdentity } from "./identity.js";
import { installAgenthop } from "./install.js";
import { startMcpServer } from "./mcp.js";
import { updateAgenthop } from "./update.js";
import { BYE, FILE, WORKING, runSession } from "./session.js";
import { version } from "./version.js";

try {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.version) {
    writeLine(`agenthop v${version}`);
  } else if (flags.help) {
    printHelp();
  } else {
    const input = classifyInput(positionals);
    if (input.kind === "help") {
      printHelp();
    } else if (input.kind === "join" || input.kind === "create") {
      const stop = new AbortController();
      process.on("SIGINT", () => stop.abort());
      await runSession({
        code: input.kind === "join" ? input.code : undefined,
        hello: input.kind === "create" ? input.hello : undefined,
        relay: flags.relay,
        pass: flags.pass ?? process.env.AGENTHOP_PASS,
        keepFiles: flags.acceptFiles,
        signal: stop.signal,
      });
      // The conversation is over. An open stdin would otherwise keep the process alive for good.
      process.exit(0);
    } else if (input.name === "mcp") {
      // Nothing else may reach standard output from here on: it is the protocol.
      await startMcpServer({ relay: flags.relay, pass: flags.pass ?? process.env.AGENTHOP_PASS });
      // The harness closing our input is the end. The inbox holds a socket open, and a server
      // that outlived its harness would keep the inbox from the next one that starts.
      process.stdin.once("end", () => process.exit(0));
      process.stdin.once("close", () => process.exit(0));
    } else if (input.name === "contacts") {
      contacts(input.words);
    } else if (input.name === "install") {
      installAgenthop({ skillDirs: flags.skillDirs, skillOnly: flags.skillOnly, mcp: flags.mcpAgents });
    } else if (input.name === "update" || input.name === "upgrade" || input.name === "self-update") {
      await updateAgenthop({ check: flags.check, force: flags.force });
    } else if (input.name === "version") {
      writeLine(`agenthop v${version}`);
    } else if (input.name === "relay") {
      const [host, portText] = (flags.listen ?? "127.0.0.1:8787").split(":");
      const running = await startRelay({
        listenHost: host,
        listenPort: portText ? Number(portText) : undefined,
        pass: flags.pass ?? process.env.AGENTHOP_PASS,
      });
      writeLine(running.url);
      process.on("SIGINT", () => {
        void running.close().then(() => process.exit(0));
      });
    } else {
      printHelp();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

/** Contacts are made in a conversation, over MCP; here they can only be looked at and let go. */
function contacts(words: string[]): void {
  const home = path.join(homedir(), ".agenthop");
  if (words[0] === "forget") {
    const name = words.slice(1).join(" ");
    if (!name) throw new Error("用法：agenthop contacts forget <名字>");
    const gone = forgetContact(home, name);
    if (!gone) throw new Error(`联系人里没有"${name}"。`);
    writeLine(`已删掉联系人 ${gone.name}（指纹 ${fingerprint(gone.publicKey)}）。`);
    return;
  }
  if (words.length > 0) throw new Error("用法：agenthop contacts 列出联系人，agenthop contacts forget <名字> 删掉一个。");
  const list = loadContacts(home);
  if (list.length === 0) writeLine("还没有联系人。在 MCP 模式里和对方对话一次，再用 agenthop_save_contact 存下。");
  for (const contact of list) writeLine(`${contact.name}  指纹 ${fingerprint(contact.publicKey)}  存于 ${contact.added.slice(0, 10)}`);
  writeLine(`本机指纹：${fingerprint(loadIdentity(home).publicKey)}`);
}

function printHelp(): void {
  const lines = [
    "作为 MCP 工具（推荐）",
    "  agenthop mcp            以 MCP server 运行，给 agent 提供 agenthop_create / join / say / wait /",
    "                          working / send_file / bye / status，以及联系人的 save_contact / contacts /",
    "                          forget_contact / invite / accept / decline，不用往进程的标准输入写字。",
    "  agenthop install 会打印每个找到的 agent 的注册命令；install --mcp <agent> 替你写进它的配置",
    "  （claude、grok、codex、cursor、gemini，可重复）。",
    "",
    "联系人",
    "  每场对话里两边会互相表明身份（peer identity）。在 MCP 模式里用 agenthop_save_contact 把对方存下，",
    "  两边互存之后，agenthop_invite 按名字直接邀请，不用再转交配对码；对方的 agent 要正开着 agenthop。",
    "  没有对话时 agenthop_wait 等的是邀请，收到后用 agenthop_accept 接受、agenthop_decline 回绝。",
    "  agenthop contacts                 列出联系人和本机指纹",
    "  agenthop contacts forget <名字>   删掉一个联系人",
    "",
    "对话（命令行）",
    "  agenthop <任务背景>     创建房间，这段文字作为 hello 发给对方",
    "  agenthop <配对码>       加入对方的房间",
    "",
    "  用一次工具调用启动，让这个进程活到对话结束。",
    "  对方的话是它的标准输出。要说的话写进同一个标准输入，一行一句，不加状态名也不加 JSON。",
    "  这个进程的输出就是对话本身，要出现在用户看得到的地方。",
    "  另存一份可以，但要同时告诉用户文件的绝对路径和查看命令。",
    "",
    "  创建方的 waiting 行里有配对码，整串交给对方——最后一段是密钥，少了它加入不了。",
    "  加入方读到 peer hello 后判断这段背景是否和自己的上下文相符：",
    "  相符就写一行确认，创建方随后输出 ready；不相符就问用户，不要写标准输入。",
    `  ready 之后对方的每一句是 peer say。写一行 ${BYE} 结束对话，后面可以带一句告别的话。`,
    "",
    "  轮到你接话的只有 peer hello、peer confirm、peer say、peer files、peer bye。",
    `  读到 peer say 的第一件事是写一行 ${WORKING} <在做什么、大概多久>，然后再开始干活。`,
    "  对方那边出现的是 peer working，它不占对方的一轮——所以读到 peer working 时安心等着就行。",
    "  只在轮到自己时醒来：tail -n 0 -f <日志路径> | grep -m1 -E ' peer (say|bye|hello|confirm|files)( |$)'",
    "  对方会把 bye 说回来，两边各有 local bye 和 peer bye，然后各自退出。",
    "  读到 peer bye 不用回应，程序会自己把 bye 说回去。",
    "",
    "  按 Ctrl-C 也会先把 bye 送出去再退出。",
    "",
    "  断线会写 local reconnecting，用同一个配对码接回来后写 local reconnected。",
    "  送不出去的话写成 local undelivered <正文>，不会悄悄消失；单条超过 64 KiB 的在发出前就停下。",
    "  写得比中继放行的快时写一行 local throttled，后面的句子排队、按顺序自动发出，不用重发。",
    "  没人加入而房间过期是 local expired。",
    "  peer refused 表示那一句没有进入对话也没有落盘：对方拿不出配对码里的密钥、重复的一句，",
    "  或者这次会话用量到顶（总量 8 MiB、2000 条、单条正文 64 KiB）。",
    `  发文件写一行 ${FILE} <路径>（最大 512 KiB，内容和文件名都加密）。`,
    "  对方发来文件写 peer files，默认只记名字不保存；要保存加 --accept-files。",
    "",
    "  日志：启动后第一行 local log <绝对路径> 就是它，直接告诉用户这个路径。",
    "        创建方 <家目录>/.agenthop/sessions/<房间地址>.create.log，加入方 <房间地址>.join.log。",
    "  每行：<时间> <local|peer> <状态> <正文>（本机时间，带时区偏移）",
    "  状态：log waiting connected identity hello confirm ready say working bye",
    "        reconnecting reconnected undelivered throttled gone expired refused files other input-closed",
    "  peer identity 是对方的身份：联系人的名字，或者一个可以核对的指纹。它不占你的一轮。",
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
    "",
    "更新",
    "  agenthop update             校验后换掉程序，再把新的 SKILL.md 写回记录过的目录",
    "  agenthop update --check     只查询，不安装",
    "  agenthop update --force     版本相同也重新安装",
    "  upgrade 与 self-update 相同。",
    "  打印出「SKILL.md 没有一起更新」时，按它给的那行命令再跑一次安装。",
    "",
    "中继",
    "  默认 https://agenthop.imatrix.tech",
    "  --relay URL 或环境变量 AGENTHOP_RELAY",
    "  自建时两边都加 --pass SECRET，或设环境变量 AGENTHOP_PASS",
    "  中继对同一个房间的写入限到每分钟 60 条，读取不计。",
    "  agenthop relay [--listen HOST:PORT] [--pass SECRET]",
    "",
    "  agenthop help       agenthop --version",
  ];
  for (const line of lines) writeLine(line);
}

function writeLine(line: string): void {
  writeSync(1, `${line}\n`);
}
