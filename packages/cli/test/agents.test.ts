import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpHints, registerMcp } from "../src/agents.js";
import { parseArgs } from "../src/args.js";

const BIN = "/Users/someone/.local/bin/agenthop";

async function home() {
  return mkdtemp(path.join(tmpdir(), "agenthop-agents-"));
}

describe("plugging into agents as an MCP server", () => {
  it("says how to register with the agents it finds, using the installed path", async () => {
    const dir = await home();
    await mkdir(path.join(dir, ".cursor"));
    const hints = mcpHints(BIN, dir).join("\n");
    expect(hints).toContain("Cursor");
    expect(hints).toContain(BIN);
    expect(hints).toContain('"args":["mcp"]');
  });

  it("adds itself to a JSON config and leaves the rest of it alone", async () => {
    const dir = await home();
    const file = path.join(dir, ".cursor", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    expect(registerMcp(["cursor"], BIN, dir)[0]).toContain("已写入");
    const config = JSON.parse(await readFile(file, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.agenthop).toEqual({ command: BIN, args: ["mcp"] });
  });

  it("creates the JSON config when there is none", async () => {
    const dir = await home();
    registerMcp(["gemini"], BIN, dir);
    const config = JSON.parse(await readFile(path.join(dir, ".gemini", "settings.json"), "utf8"));
    expect(config.mcpServers.agenthop.args).toEqual(["mcp"]);
  });

  it("will not rewrite a config it cannot read as plain JSON", async () => {
    const dir = await home();
    const file = path.join(dir, ".gemini", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    const original = '{ // a comment\n  "theme": "dark" }';
    await writeFile(file, original);
    const [result] = registerMcp(["gemini"], BIN, dir);
    expect(result).toContain("没有写成");
    expect(result).toContain("手动做");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("adds a Codex block once, however many times it is asked", async () => {
    const dir = await home();
    const file = path.join(dir, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'model = "o4"\n');
    registerMcp(["codex"], BIN, dir);
    expect(registerMcp(["codex"], BIN, dir)[0]).toContain("已经有 agenthop 了");
    const text = await readFile(file, "utf8");
    expect(text.startsWith('model = "o4"\n')).toBe(true);
    expect(text.match(/\[mcp_servers\.agenthop\]/g)).toHaveLength(1);
    expect(text).toContain(`command = "${BIN}"`);
  });

  it("names an agent it does not know instead of guessing", async () => {
    const dir = await home();
    expect(registerMcp(["vscode"], BIN, dir)[0]).toContain("不认识的 agent");
    expect(existsSync(path.join(dir, ".vscode"))).toBe(false);
  });

  it("takes --mcp more than once", () => {
    expect(parseArgs(["install", "--mcp", "grok", "--mcp", "cursor"]).flags.mcpAgents).toEqual(["grok", "cursor"]);
    expect(() => parseArgs(["install", "--mcp"])).toThrow(/--mcp 后面要跟/);
  });
});
