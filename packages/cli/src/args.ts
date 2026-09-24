import { isPairingCode, isRoomAddress, normalizeCode } from "@agenthop/tunnel";

export type Flags = {
  relay?: string;
  pass?: string;
  listen?: string;
  skillDirs: string[];
  check: boolean;
  force: boolean;
  skillOnly: boolean;
  acceptFiles: boolean;
  help: boolean;
  version: boolean;
};

export type Parsed = { flags: Flags; positionals: string[] };

const VALUE_FLAGS: Record<string, keyof Pick<Flags, "relay" | "pass" | "listen">> = {
  "--relay": "relay",
  "--pass": "pass",
  "--listen": "listen",
};

/** Flags that older releases documented. Naming them beats "unknown option". */
const RETIRED_FLAGS: Record<string, string> = {
  "--agent": "现在不需要把另一个 agent 填进来：agenthop 自己一直跑着，对方的话在标准输出，要说的话写进标准输入。",
  "--on-receive": "现在不需要每条消息拉起一条命令：同一个 agenthop 进程会把对方的话写到标准输出。",
  "--ask": "现在每一行都是同一条对话里的一句话，不再分提问和回答。",
  "--answer": "现在每一行都是同一条对话里的一句话，不再分提问和回答。",
  "--supplement": "现在每一行都是同一条对话里的一句话，补充直接再写一行。",
  "--file": "这一版的对话只走文本。",
  "--out": "这一版的对话只走文本。",
  "--text": "正文直接写进标准输入，一行就是一句。",
  "--json": "输出格式就是日志那一行：<时间> <local|peer> <状态> <正文>。",
};

/** Commands that older releases documented. */
const RETIRED_COMMANDS = new Set(["host", "join", "watch", "send", "reply", "queue", "inbox"]);

export const COMMANDS = new Set(["install", "update", "upgrade", "self-update", "relay", "help", "version"]);

export function parseArgs(args: string[]): Parsed {
  const flags: Flags = { skillDirs: [], check: false, force: false, skillOnly: false, acceptFiles: false, help: false, version: false };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const valueFlag = VALUE_FLAGS[arg];
    if (valueFlag) {
      const value = args[++i];
      if (!value) throw new Error(`${arg} 后面要跟一个值`);
      flags[valueFlag] = value;
    } else if (arg === "--skill-dir") {
      const value = args[++i];
      if (!value) throw new Error("--skill-dir 后面要跟一个目录");
      flags.skillDirs.push(value);
    } else if (arg === "--accept-files") flags.acceptFiles = true;
    else if (arg === "--skill-only") flags.skillOnly = true;
    else if (arg === "--check") flags.check = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (RETIRED_FLAGS[arg]) throw new Error(`${arg} 已经没有了。${RETIRED_FLAGS[arg]}\n${usageHint()}`);
    else if (arg.startsWith("-")) throw new Error(`不认识的选项 ${arg}。\n${usageHint()}`);
    else positionals.push(arg);
  }
  return { flags, positionals };
}

export type Input =
  | { kind: "command"; name: string; words: string[] }
  | { kind: "join"; code: string }
  | { kind: "create"; hello: string }
  | { kind: "help" };

/**
 * A pairing code is four digits, three words and a secret. Case, spaces and hyphens do not
 * matter, so `1720-Spiny-Patch-Easel-<secret>` and the same thing typed with spaces both join.
 * Anything that starts like a code but is not one is an error, never a new room.
 */
export function classifyInput(positionals: string[]): Input {
  const first = positionals[0] ?? "";
  if (COMMANDS.has(first)) return { kind: "command", name: first, words: positionals.slice(1) };
  if (RETIRED_COMMANDS.has(first)) throw new Error(`agenthop ${first} 已经没有了。\n${usageHint()}`);
  if (positionals.length === 0) return { kind: "help" };
  const joined = positionals.join(" ");
  if (looksLikeCode(joined)) {
    const code = normalizeCode(joined);
    // A code that stops after the three words is a v0.3 code, or one that got cut short on the
    // way over. Both are worth saying out loud, because neither looks like a typo.
    if (isRoomAddress(code)) {
      throw new Error(
        `这个配对码少了最后一段密钥：${code}\n` +
          `可能是复制的时候被截断了，也可能对方还在用 v0.3。从 v0.4 起配对码有五段，最后一段是 26 位的密钥，` +
          `没有它读不到对话。请对方先 agenthop update，再把 waiting 那一行整行发过来。`,
      );
    }
    if (!isPairingCode(code)) {
      throw new Error(
        `这不像一个配对码：${abbreviate(joined)}\n` +
          `配对码是四位数字、三个英文词，再加一段 26 位的密钥，例如 1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3d。`,
      );
    }
    return { kind: "join", code };
  }
  return { kind: "create", hello: joined };
}

function looksLikeCode(text: string): boolean {
  return /^\d{4}[-\s_]/.test(text.trim());
}

/** Echoing a nearly-right code back in full would copy the secret into the agent's transcript. */
function abbreviate(text: string): string {
  const parts = normalizeCode(text).split("-");
  return parts.length <= 4 ? parts.join("-") : `${parts.slice(0, 4).join("-")}-…`;
}

function usageHint(): string {
  return '现在创建房间是 agenthop "<任务背景>"，加入是 agenthop <配对码>。完整用法看 agenthop help。';
}
