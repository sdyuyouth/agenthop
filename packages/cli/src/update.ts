import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_RELAY } from "./host.js";
import { ensureDir } from "./install.js";
import { version } from "./version.js";

const ASSETS: Record<string, string> = {
  "darwin-arm64": "agenthop-macos-arm64",
  "darwin-x64": "agenthop-macos-x64",
  "linux-arm64": "agenthop-linux-arm64",
  "linux-x64": "agenthop-linux-x64",
  "win32-x64": "agenthop-windows-x64.exe",
};

export type ReleaseInfo = { tag: string; assets: string[] };

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
  const target = options.target ?? installTarget();
  const downloaded = `${target}.download`;
  ensureDir(dirname(target));
  await download(`${base}/download/${asset}`, downloaded);
  replaceExecutable(target, downloaded);
  console.log(target);
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
