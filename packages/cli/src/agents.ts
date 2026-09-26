import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * The agents agenthop knows how to plug into as an MCP server. `install` finds the ones on this
 * machine and prints how to register it with each — writing into another tool's configuration
 * is a lasting change, so it only does that when asked by name (`--mcp <agent>`).
 */

export const AGENT_IDS = ["claude", "grok", "codex", "cursor", "gemini"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

type Agent = {
  id: AgentId;
  name: string;
  present(home: string): boolean;
  /** What a person would run or paste to register agenthop. */
  hint(bin: string, home: string): string;
  /** Do it. Returns what changed, in words. */
  register(bin: string, home: string): string;
};

const SERVER = "agenthop";

const agents: Agent[] = [
  {
    id: "claude",
    name: "Claude Code",
    present: (home) => existsSync(join(home, ".claude")) || onPath("claude"),
    hint: (bin) => `claude mcp add --scope user ${SERVER} -- ${quote(bin)} mcp`,
    register: (bin) => run("claude", ["mcp", "add", "--scope", "user", SERVER, "--", bin, "mcp"], "Claude Code"),
  },
  {
    id: "grok",
    name: "grok",
    present: (home) => existsSync(join(home, ".grok")) || onPath("grok"),
    hint: (bin) => `grok mcp add --scope user ${SERVER} ${quote(bin)} -- mcp`,
    register: (bin) => run("grok", ["mcp", "add", "--scope", "user", SERVER, bin, "--", "mcp"], "grok"),
  },
  {
    id: "codex",
    name: "Codex",
    present: (home) => existsSync(join(home, ".codex")) || onPath("codex"),
    hint: (bin, home) => `在 ${join(home, ".codex", "config.toml")} 里加上：\n${codexBlock(bin)}`,
    register: (bin, home) => {
      const file = join(home, ".codex", "config.toml");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (/^\[mcp_servers\.agenthop\]/m.test(existing)) return `${file} 里已经有 agenthop 了，没有改动`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${codexBlock(bin)}\n`);
      return `已写入 ${file}`;
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    present: (home) => existsSync(join(home, ".cursor")),
    hint: (bin, home) => `在 ${join(home, ".cursor", "mcp.json")} 的 mcpServers 里加上：${JSON.stringify(entry(bin))}`,
    register: (bin, home) => mergeJson(join(home, ".cursor", "mcp.json"), bin),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    present: (home) => existsSync(join(home, ".gemini")) || onPath("gemini"),
    hint: (bin, home) => `在 ${join(home, ".gemini", "settings.json")} 的 mcpServers 里加上：${JSON.stringify(entry(bin))}`,
    register: (bin, home) => mergeJson(join(home, ".gemini", "settings.json"), bin),
  },
];

/** How to register agenthop with each agent found here, or with all of them if none is. */
export function mcpHints(bin: string, home = homedir()): string[] {
  const found = agents.filter((agent) => agent.present(home));
  return (found.length > 0 ? found : agents).map((agent) => `  ${agent.name}：${agent.hint(bin, home).replace(/\n/g, "\n    ")}`);
}

export function registerMcp(ids: string[], bin: string, home = homedir()): string[] {
  return ids.map((id) => {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return `不认识的 agent：${id}。可以是 ${AGENT_IDS.join("、")}。`;
    try {
      return `${agent.name}：${agent.register(bin, home)}`;
    } catch (error) {
      return `${agent.name}：没有写成（${error instanceof Error ? error.message : String(error)}）。手动做：${agent.hint(bin, home)}`;
    }
  });
}

function entry(bin: string) {
  return { [SERVER]: { command: bin, args: ["mcp"] } };
}

function codexBlock(bin: string): string {
  return `[mcp_servers.agenthop]\ncommand = ${JSON.stringify(bin)}\nargs = ["mcp"]`;
}

/**
 * Add agenthop to a JSON config and leave everything else in it alone. A file that is not plain
 * JSON is not rewritten: a guess at someone's configuration is worse than no change.
 */
function mergeJson(file: string, bin: string): string {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} 不是纯 JSON，没有动它`);
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  config.mcpServers = { ...servers, ...entry(bin) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return `已写入 ${file}`;
}

function run(command: string, args: string[], name: string): string {
  if (!onPath(command)) throw new Error(`找不到 ${command} 命令`);
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} 退出码 ${result.status}`).trim());
  return `已注册到 ${name}`;
}

function onPath(command: string): boolean {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && names.some((name) => existsSync(join(dir, name))));
}

function quote(text: string): string {
  return /[\s"'$`\\]/.test(text) ? JSON.stringify(text) : text;
}
