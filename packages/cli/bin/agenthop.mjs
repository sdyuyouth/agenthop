#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
const root = join(here, "..", "..", "..");
const tsx = [join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(root, "node_modules", "tsx", "dist", "cli.mjs")].find(
  (candidate) => existsSync(candidate),
);
if (!tsx) {
  console.error("agenthop: dependencies are missing. From the repository root run: node scripts/setup.mjs");
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, join(root, "packages", "cli", "src", "bin.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
// Ctrl-C reaches the whole group in a terminal; forward it too so `node bin/agenthop.mjs`
// gets the same chance to say goodbye as the released program.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
