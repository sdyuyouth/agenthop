#!/usr/bin/env node
// One setup for Windows, Linux, and macOS. Agents should run this and not invent their own install steps.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "packages", "cli", "bin", "agenthop.mjs");
const skillFile = join(root, "skill", "SKILL.md");
const skillDirs = readSkillDirs(process.argv.slice(2));
const windows = platform() === "win32";
const installed = [];

if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error("agenthop: need Node.js 20 or newer");
  process.exit(1);
}

if (!commandExists("pnpm")) {
  run("corepack", ["enable"]);
  run("corepack", ["prepare", "pnpm@12.4.1", "--activate"]);
}
run("pnpm", ["install"]);

installCommand();
installSkills();
verify();
console.log(installed.map((line) => `- ${line}`).join("\n"));

function installCommand() {
  chmodSync(launcher, 0o755);
  if (windows) {
    const cmd = `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`;
    const nodeDir = dirname(process.execPath);
    if (canWrite(nodeDir)) {
      writeFileSync(join(nodeDir, "agenthop.cmd"), cmd);
      installed.push(`command ${join(nodeDir, "agenthop.cmd")}`);
    }
    const dest = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agenthop");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "agenthop.cmd"), cmd);
    ensureWindowsPath(dest);
    installed.push(`command ${join(dest, "agenthop.cmd")}`);
    return;
  }
  const nodeDir = dirname(process.execPath);
  if (canWrite(nodeDir)) {
    linkFile(launcher, join(nodeDir, "agenthop"));
    installed.push(`command ${join(nodeDir, "agenthop")}`);
  }
  const dest = join(homedir(), ".local", "bin");
  mkdirSync(dest, { recursive: true });
  linkFile(launcher, join(dest, "agenthop"));
  ensureUnixPath(dest);
  installed.push(`command ${join(dest, "agenthop")}`);
}

function installSkills() {
  const files = [join(homedir(), ".agenthop", "SKILL.md")];
  for (const dir of skillDirs) files.push(join(resolve(dir), "SKILL.md"));
  for (const file of files) {
    placeSkill(file);
    installed.push(`skill ${file}`);
  }
}

function readSkillDirs(args) {
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--skill-dir") {
      console.error("usage: node scripts/setup.mjs [--skill-dir DIR]");
      process.exit(1);
    }
    const dir = args[++i];
    if (!dir) {
      console.error("usage: node scripts/setup.mjs [--skill-dir DIR]");
      process.exit(1);
    }
    dirs.push(dir);
  }
  return dirs;
}

function placeSkill(file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    linkFile(skillFile, file);
  } catch {
    writeFileSync(file, readFileSync(skillFile));
  }
}

function verify() {
  const result = spawnSync(process.execPath, [launcher], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 || !output.includes("agenthop <配对码>")) {
    console.error(output);
    console.error("agenthop: setup finished but the command did not print its usage");
    process.exit(1);
  }
}

function ensureUnixPath(dir) {
  if (onPath(dir)) return;
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  const shell = process.env.SHELL ?? "";
  const files = [join(homedir(), ".profile")];
  if (shell.includes("zsh")) files.push(join(homedir(), ".zshrc"));
  else files.push(join(homedir(), ".bashrc"));
  for (const file of files) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.includes(".local/bin")) writeFileSync(file, `${current.replace(/\s*$/, "")}\n${line}\n`);
  }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  installed.push(`PATH ${dir}`);
}

function ensureWindowsPath(dir) {
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
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.env.Path = `${dir}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
  installed.push(`PATH ${dir}`);
}

function linkFile(target, link) {
  if (sameLink(link, target)) return;
  removeExisting(link);
  symlinkSync(target, link);
}

function removeExisting(link) {
  try {
    lstatSync(link);
  } catch {
    return;
  }
  rmSync(link, { recursive: true, force: true });
}

function sameLink(link, target) {
  try {
    if (!existsSync(link)) return false;
    const info = lstatSync(link);
    if (info.isSymbolicLink()) return resolve(dirname(link), readlinkSync(link)) === resolve(target);
    return resolve(link) === resolve(target);
  } catch {
    return false;
  }
}

function onPath(dir) {
  return (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .some((entry) => entry && resolve(entry) === resolve(dir));
}

function canWrite(dir) {
  const probe = join(dir, `.agenthop-${process.pid}`);
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function commandExists(name) {
  const result = windows
    ? spawnSync("where.exe", [name], { stdio: "ignore" })
    : spawnSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
  return result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
