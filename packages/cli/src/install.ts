import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, parse, resolve } from "node:path";
import { skillMarkdown } from "./skill-text.js";

const windows = platform() === "win32";

export type InstallOptions = {
  /** Directories that should contain SKILL.md. The caller names its own skill folder. */
  skillDirs?: string[];
};

/** Copy this program onto PATH and write the skill. No repository and no package install. */
export function installAgenthop(options: InstallOptions = {}): void {
  const command = installCommand();
  const skills = writeSkillFiles(options.skillDirs ?? []);
  console.log(command);
  for (const skill of skills) console.log(skill);
}

/** Write SKILL.md under the home directory and into each directory the caller provides. */
export function writeSkillFiles(skillDirs: string[], home = homedir()): string[] {
  const files = [join(home, ".agenthop", "SKILL.md")];
  for (const dir of skillDirs) {
    if (!dir.trim()) throw new Error("usage: agenthop install [--skill-dir DIR]");
    files.push(join(resolve(dir), "SKILL.md"));
  }
  for (const file of files) {
    ensureDir(dirname(file));
    writeFileSync(file, skillMarkdown);
  }
  return files;
}

function installCommand(): string {
  const source = process.execPath;
  const dev = isNodeBinary(source);
  if (windows) {
    const destDir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agenthop");
    ensureDir(destDir);
    const dest = join(destDir, "agenthop.exe");
    if (!dev) copyFileSync(source, dest);
    else writeFileSync(join(destDir, "agenthop.cmd"), `@echo off\r\nnode "${source}" %*\r\n`);
    ensureWindowsPath(destDir);
    return dev ? join(destDir, "agenthop.cmd") : dest;
  }
  const destDir = join(homedir(), ".local", "bin");
  ensureDir(destDir);
  const dest = join(destDir, "agenthop");
  if (dev) {
    if (!sameFile(dest, source)) {
      rmSync(dest, { force: true });
      symlinkSync(source, dest);
    }
  } else {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
  }
  ensureUnixPath(destDir);
  return dest;
}

export function ensureDir(dir: string): void {
  const absolute = resolve(dir);
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
  }
}

function isNodeBinary(file: string): boolean {
  const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return name === "node" || name === "node.exe";
}

function sameFile(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === resolve(target);
  } catch {
    return false;
  }
}

function ensureUnixPath(dir: string): void {
  if (onPath(dir)) return;
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  const shell = process.env.SHELL ?? "";
  const files = [join(homedir(), ".profile"), join(homedir(), shell.includes("zsh") ? ".zshrc" : ".bashrc")];
  for (const file of files) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = "";
    }
    if (!current.includes(".local/bin")) writeFileSync(file, `${current.replace(/\s*$/, "")}\n${line}\n`);
  }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

function ensureWindowsPath(dir: string): void {
  if (onPath(dir)) return;
  const command = `
    $dir = '${dir.replaceAll("'", "''")}'
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $user) { $user = '' }
    $parts = @($user -split ';' | Where-Object { $_ -ne '' })
    if ($parts -notcontains $dir) {
      $updated = $(if ($user) { "$user;$dir" } else { $dir })
      [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    }
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("could not update the user PATH");
  process.env.Path = `${dir}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
}

function onPath(dir: string): boolean {
  return (process.env.PATH ?? process.env.Path ?? "").split(delimiter).some((entry) => entry && resolve(entry) === resolve(dir));
}
