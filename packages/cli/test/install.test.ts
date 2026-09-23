import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandSource, writeSkillFiles } from "../src/install.js";

describe("skill install", () => {
  it("writes SKILL.md into the home directory and into each directory the caller names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-install-"));
    const home = path.join(dir, "home");
    const skillDir = path.join(dir, "any-agent", "skills", "agenthop");
    const written = writeSkillFiles([skillDir], home);
    expect(written).toEqual([path.join(home, ".agenthop", "SKILL.md"), path.join(skillDir, "SKILL.md")]);
    const text = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(text).toContain("name: agenthop");
    expect(text).toContain("--skill-dir");
    expect(text).not.toContain(".grok");
    expect(await readFile(path.join(home, ".agenthop", "SKILL.md"), "utf8")).toBe(text);
  });

  it("puts the launcher on PATH from a source checkout, never the node binary", () => {
    const dev = commandSource("/usr/local/bin/node");
    expect(dev.dev).toBe(true);
    expect(dev.source.endsWith(path.join("bin", "agenthop.mjs"))).toBe(true);
    expect(commandSource("/tmp/agenthop-macos-arm64")).toEqual({ dev: false, source: "/tmp/agenthop-macos-arm64" });
  });
});
