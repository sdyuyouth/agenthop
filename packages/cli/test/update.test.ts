import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberSkillDirs } from "../src/install.js";
import { refreshSkill, releaseAsset, replaceExecutable, sameRelease, skillReminder } from "../src/update.js";

afterEach(() => vi.restoreAllMocks());

describe("update", () => {
  it("names the release file for this kind of machine", () => {
    expect(releaseAsset("darwin", "arm64")).toBe("agenthop-macos-arm64");
    expect(releaseAsset("darwin", "x64")).toBe("agenthop-macos-x64");
    expect(releaseAsset("linux", "x64")).toBe("agenthop-linux-x64");
    expect(releaseAsset("linux", "arm64")).toBe("agenthop-linux-arm64");
    expect(releaseAsset("win32", "x64")).toBe("agenthop-windows-x64.exe");
  });

  it("treats v0.1.6 and 0.1.6 as the same release", () => {
    expect(sameRelease("0.1.6", "v0.1.6")).toBe(true);
    expect(sameRelease("0.1.5", "v0.1.6")).toBe(false);
  });

  it("replaces an existing program file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-update-"));
    const target = path.join(dir, "agenthop");
    const next = path.join(dir, "next");
    await writeFile(target, "old");
    await writeFile(next, "new");
    replaceExecutable(target, next);
    expect(await import("node:fs/promises").then((fs) => fs.readFile(target, "utf8"))).toBe("new");
  });

  it("writes the new skill with the new program", () => {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "/home/me/.agenthop/SKILL.md\n", stderr: "" });

    refreshSkill("/home/me/.local/bin/agenthop", run as never);

    expect(run).toHaveBeenCalledWith("/home/me/.local/bin/agenthop", ["install", "--skill-only"], { encoding: "utf8" });
    expect(printed).toEqual(["/home/me/.agenthop/SKILL.md"]);
  });

  it("says how to write the skill by hand when the new program cannot do it", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));

    refreshSkill("/home/me/.local/bin/agenthop", vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "old" }) as never);

    expect(printed.join("\n")).toContain("SKILL.md 没有一起更新");
    expect(printed.join("\n")).toContain("install");
  });

  it("names the recorded directories in that reminder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-update-"));
    const home = path.join(dir, "home");
    const skillDir = path.join(dir, "agent", "skills", "agenthop");
    rememberSkillDirs([skillDir], home);
    expect(skillReminder("/bin/agenthop", home)).toContain(`--skill-dir ${skillDir}`);
  });
});
