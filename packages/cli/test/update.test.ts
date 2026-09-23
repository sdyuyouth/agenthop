import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberSkillDirs } from "../src/install.js";
import { parseSums, refreshSkill, releaseAsset, replaceExecutable, sameRelease, sha256, skillReminder, updateAgenthop } from "../src/update.js";

const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENTHOP_RELEASES_BASE;
  for (const server of servers.splice(0)) server.close();
});

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

  it("reads the published hashes and ignores anything else in the file", () => {
    const sums = parseSums(
      [
        "# a comment",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  agenthop-macos-arm64",
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *agenthop-windows-x64.exe",
        "not a hash at all",
      ].join("\n"),
    );
    expect(sums.get("agenthop-macos-arm64")).toBe("a".repeat(64));
    expect(sums.get("agenthop-windows-x64.exe")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  it("refuses a download whose hash is not the published one, and keeps the program that is there", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-update-"));
    const target = path.join(dir, "agenthop");
    await writeFile(target, "the program that works");
    const asset = releaseAsset();
    const served = Buffer.alloc(1_100_000, 7);
    const wrong = "0".repeat(64);
    const base = await serve({
      "/latest": JSON.stringify({ tag: "v9.9.9", assets: [asset] }),
      "/v9.9.9/SHA256SUMS": `${wrong}  ${asset}\n`,
      [`/download/${asset}`]: served,
    });
    process.env.AGENTHOP_RELEASES_BASE = base;

    await expect(updateAgenthop({ base, target, force: true })).rejects.toThrow(/校验和对不上/);
    expect(await readFile(target, "utf8")).toBe("the program that works");
    expect(existsSync(`${target}.download`)).toBe(false);
  });

  it("installs a download whose hash matches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-update-"));
    const target = path.join(dir, "agenthop");
    await writeFile(target, "the old program");
    const asset = releaseAsset();
    const served = Buffer.alloc(1_100_000, 9);
    const staged = path.join(dir, "served");
    await writeFile(staged, served);
    const base = await serve({
      "/latest": JSON.stringify({ tag: "v9.9.9", assets: [asset] }),
      "/v9.9.9/SHA256SUMS": `${sha256(staged)}  ${asset}\n`,
      [`/download/${asset}`]: served,
    });
    process.env.AGENTHOP_RELEASES_BASE = base;

    await updateAgenthop({ base, target, force: true });
    expect(sha256(target)).toBe(sha256(staged));
  });
});

async function serve(routes: Record<string, string | Buffer>): Promise<string> {
  const server = createServer((request, response) => {
    const body = routes[(request.url ?? "").split("?")[0] ?? ""];
    if (body === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-length": String(Buffer.byteLength(body as string)) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return `http://127.0.0.1:${address.port}`;
}
