import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";

const launcher = fileURLToPath(new URL("../bin/agenthop.mjs", import.meta.url));
const started: ChildProcessWithoutNullStreams[] = [];
const relays: RunningRelay[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("the command itself", () => {
  it(
    "ends both processes on goodbye even though standard input is still open",
    async () => {
      const relay = await startRelay();
      relays.push(relay);
      const home = await mkdtemp(path.join(tmpdir(), "agenthop-cli-"));
      const creator = run(["我这边在做整顿"], relay.url, home);
      const code = await waitFor(creator, /waiting (\S+)/);
      const joiner = run([code.toUpperCase()], relay.url, home);

      await waitFor(joiner, /peer hello 我这边在做整顿/);
      joiner.stdin.write("确认，背景一致\n");
      await waitFor(creator, /local ready/);
      creator.stdin.write("第一句\n");
      await waitFor(joiner, /peer say 第一句/);

      creator.stdin.write("/bye\n");
      expect(await exitOf(creator)).toBe(0);
      expect(await exitOf(joiner)).toBe(0);
    },
    40000,
  );

  it(
    "refuses a command older releases documented instead of opening a room",
    async () => {
      const child = run(["host"], "http://127.0.0.1:1", await mkdtemp(path.join(tmpdir(), "agenthop-cli-")));
      const output = collect(child);
      expect(await exitOf(child)).toBe(1);
      expect(output()).toContain("agenthop host 已经没有了");
    },
    20000,
  );
});

function run(args: string[], relay: string, home: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [launcher, ...args], {
    env: { ...process.env, AGENTHOP_RELAY: relay, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  started.push(child);
  return child;
}

function collect(child: ChildProcessWithoutNullStreams): () => string {
  let seen = "";
  child.stdout.on("data", (chunk: string) => (seen += chunk));
  child.stderr.on("data", (chunk: string) => (seen += chunk));
  return () => seen;
}

function waitFor(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`${pattern} never arrived in:\n${seen}`)), 15000);
    const read = (chunk: string) => {
      seen += chunk;
      const found = seen.match(pattern);
      if (!found) return;
      clearTimeout(timer);
      child.stdout.off("data", read);
      resolve(found[1] ?? found[0]);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
}

function exitOf(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}
