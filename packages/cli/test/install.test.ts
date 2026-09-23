import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandSource, isSameFile, placeCommand, readSkillDirs, rememberSkillDirs, writeSkillFiles } from "../src/install.js";

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

  it("remembers every skill directory it has been given, so a later update can find them all", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-install-"));
    const home = path.join(dir, "home");
    const first = path.join(dir, "agent-one", "skills", "agenthop");
    const second = path.join(dir, "agent-two", "skills", "agenthop");

    expect(rememberSkillDirs([first], home)).toEqual([first]);
    expect(rememberSkillDirs([second], home)).toEqual([first, second]);
    expect(rememberSkillDirs([], home)).toEqual([first, second]);
    expect(readSkillDirs(home)).toEqual([first, second]);

    const written = writeSkillFiles(readSkillDirs(home), home);
    expect(written).toEqual([
      path.join(home, ".agenthop", "SKILL.md"),
      path.join(first, "SKILL.md"),
      path.join(second, "SKILL.md"),
    ]);
  });

  it("has no directories to remember before the first install", async () => {
    const home = path.join(await mkdtemp(path.join(tmpdir(), "agenthop-install-")), "home");
    expect(readSkillDirs(home)).toEqual([]);
  });

  it("leaves the program alone when the source and the destination are one file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-install-"));
    const real = path.join(dir, "bin");
    await mkdir(real);
    const program = path.join(real, "agenthop");
    await writeFile(program, "the program");
    await symlink(real, path.join(dir, "link"));
    const otherName = path.join(dir, "link", "agenthop");

    expect(isSameFile(program, otherName)).toBe(true);
    placeCommand(otherName, program);
    expect(await readFile(program, "utf8")).toBe("the program");
  });

  it("replaces a different program without destroying it when the copy fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-install-"));
    const dest = path.join(dir, "agenthop");
    const source = path.join(dir, "downloaded");
    await writeFile(dest, "old program");
    await writeFile(source, "new program");
    expect(isSameFile(source, dest)).toBe(false);

    placeCommand(source, dest);
    expect(await readFile(dest, "utf8")).toBe("new program");

    expect(() => placeCommand(path.join(dir, "missing"), dest)).toThrow();
    expect(await readFile(dest, "utf8")).toBe("new program");
  });
});
