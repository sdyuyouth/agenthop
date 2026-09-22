import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseAsset, replaceExecutable, sameRelease } from "../src/update.js";

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
});
