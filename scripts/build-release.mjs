#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, ".grok/skills/agenthop/SKILL.md"), "utf8");
writeFileSync(join(root, "packages/cli/src/skill-text.ts"), `export const skillMarkdown = ${JSON.stringify(skill)};\n`);

const targets = [
  ["bun-darwin-arm64", "agenthop-macos-arm64"],
  ["bun-darwin-x64", "agenthop-macos-x64"],
  ["bun-linux-x64", "agenthop-linux-x64"],
  ["bun-linux-arm64", "agenthop-linux-arm64"],
  ["bun-windows-x64", "agenthop-windows-x64.exe"],
];
mkdirSync(join(root, "dist"), { recursive: true });
for (const [target, name] of targets) {
  const result = spawnSync(
    "bun",
    ["build", "packages/cli/src/bin.ts", "--compile", `--target=${target}`, `--outfile=dist/${name}`],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
