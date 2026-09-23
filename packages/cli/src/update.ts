import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_RELAY } from "./host.js";
import { ensureDir, readSkillDirs } from "./install.js";
import { version } from "./version.js";

const ASSETS: Record<string, string> = {
  "darwin-arm64": "agenthop-macos-arm64",
  "darwin-x64": "agenthop-macos-x64",
  "linux-arm64": "agenthop-linux-arm64",
  "linux-x64": "agenthop-linux-x64",
  "win32-x64": "agenthop-windows-x64.exe",
};

export type ReleaseInfo = { tag: string; assets: string[] };

const GITHUB_RELEASES = "https://github.com/sdyuyouth/agenthop/releases/download";

function releasesBase(): string {
  return (process.env.AGENTHOP_RELEASES_BASE ?? GITHUB_RELEASES).replace(/\/$/, "");
}

export function releaseAsset(system = platform(), cpu = arch()): string {
  const name = ASSETS[`${system}-${cpu}`];
  if (!name) throw new Error(`no release for ${system} ${cpu}`);
  return name;
}

export function sameRelease(local: string, remote: string): boolean {
  return local.replace(/^v/, "") === remote.replace(/^v/, "");
}

export async function updateAgenthop(options: { check?: boolean; force?: boolean; base?: string; target?: string } = {}): Promise<void> {
  const base = (options.base ?? process.env.AGENTHOP_UPDATE_BASE ?? DEFAULT_RELAY).replace(/\/$/, "");
  const latest = await readLatest(base);
  const asset = releaseAsset();
  if (options.check) {
    console.log(`local v${version.replace(/^v/, "")}`);
    console.log(`latest ${latest.tag}`);
    return;
  }
  if (!options.force && sameRelease(version, latest.tag)) {
    console.log(`already current v${version.replace(/^v/, "")}`);
    return;
  }
  if (!latest.assets.includes(asset)) throw new Error(`release ${latest.tag} has no ${asset}`);
  const sums = await readSums(base, latest.tag);
  const expected = sums.hashes.get(asset);
  if (!expected) throw new Error(`release ${latest.tag} 没有 ${asset} 的校验和，不敢装`);
  const target = options.target ?? installTarget();
  const downloaded = `${target}.download`;
  ensureDir(dirname(target));
  await download(`${base}/download/${asset}`, downloaded);
  const actual = sha256(downloaded);
  if (actual !== expected) {
    rmSync(downloaded, { force: true });
    throw new Error(`下载回来的文件和 ${sums.from} 上的校验和对不上，已经丢弃，没有替换现在的程序。\n  期望 ${expected}\n  实际 ${actual}`);
  }
  console.log(`sha256 ${actual} (校验和来自 ${sums.from})`);
  replaceExecutable(target, downloaded);
  console.log(target);
  refreshSkill(target);
}

/**
 * The skill text lives inside the program, so only the new program can write the new skill.
 * Run it once for that. If it cannot run, say what to run by hand rather than leave the old
 * SKILL.md sitting there looking current.
 */
export function refreshSkill(target: string, run = spawnSync): void {
  const result = run(target, ["install", "--skill-only"], { encoding: "utf8" });
  const written = (result.stdout ?? "").trim();
  if (!result.error && result.status === 0 && written) {
    for (const line of written.split("\n")) console.log(line);
    return;
  }
  console.log(skillReminder(target));
}

export function skillReminder(target: string, home = homedir()): string {
  const dirs = readSkillDirs(home);
  const named = dirs.map((dir) => ` --skill-dir ${dir}`).join("");
  return [
    "SKILL.md 没有一起更新。技能文本在程序里面，要再跑一次安装才会写出来：",
    `  ${target} install${named}`,
  ].join("\n");
}

/**
 * The program is fetched through the relay, so the hashes are fetched from GitHub: one of them
 * would have to be wrong on its own for a swapped program to be installed. When GitHub cannot be
 * reached the relay's copy is used and said so, which only proves the download arrived intact.
 */
export async function readSums(base: string, tag: string): Promise<{ hashes: Map<string, string>; from: string }> {
  const sources = [
    { from: "github.com", url: `${releasesBase()}/${tag}/SHA256SUMS` },
    { from: "中继（与程序同源）", url: `${base}/download/SHA256SUMS` },
  ];
  let last = "";
  for (const source of sources) {
    try {
      const response = await fetch(source.url, { headers: { "user-agent": "agenthop" } });
      if (!response.ok) {
        last = `${source.url} → ${response.status}`;
        continue;
      }
      const hashes = parseSums(await response.text());
      if (hashes.size > 0) return { hashes, from: source.from };
      last = `${source.url} → 空文件`;
    } catch (error) {
      last = `${source.url} → ${error instanceof Error ? error.message : error}`;
    }
  }
  throw new Error(`拿不到校验和，没有替换现在的程序。${last}`);
}

export function parseSums(body: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (match) hashes.set(match[2]!, match[1]!.toLowerCase());
  }
  return hashes;
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function readLatest(base: string): Promise<ReleaseInfo> {
  const response = await fetch(`${base}/latest`);
  if (!response.ok) throw new Error(`update lookup failed (${response.status})`);
  const body = (await response.json()) as { tag?: string; assets?: string[] };
  if (!body.tag) throw new Error("update lookup returned no tag");
  return { tag: body.tag, assets: body.assets ?? [] };
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`update download failed (${response.status})`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const size = lstatSync(file).size;
  if (size < 1_000_000) {
    rmSync(file, { force: true });
    throw new Error("downloaded file is too small");
  }
}

export function replaceExecutable(target: string, next: string): void {
  try {
    chmodSync(next, 0o755);
  } catch {
    // Windows may refuse the mode. The file is still the new program.
  }
  if (!exists(target)) {
    renameSync(next, target);
    return;
  }
  if (lstatSync(target).isSymbolicLink()) throw new Error(`${target} is a source checkout`);
  const previous = `${target}.old`;
  rmSync(previous, { force: true });
  renameSync(target, previous);
  try {
    renameSync(next, target);
  } catch (error) {
    try {
      renameSync(previous, target);
    } catch {
      // The new file is still at `next`. Surface the original error.
    }
    throw error;
  }
  try {
    rmSync(previous, { force: true });
  } catch {
    // Windows can keep the running image under the .old name until this process exits.
  }
}

function installTarget(): string {
  if (!isNode(process.execPath)) return process.execPath;
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agenthop", "agenthop.exe");
  }
  return join(homedir(), ".local", "bin", "agenthop");
}

function isNode(file: string): boolean {
  const name = basename(file).toLowerCase();
  return name === "node" || name === "node.exe";
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
