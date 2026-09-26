import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";

const launcher = fileURLToPath(new URL("../bin/agenthop.mjs", import.meta.url));
const started: ChildProcessWithoutNullStreams[] = [];
const relays: RunningRelay[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

/**
 * A real `agenthop mcp` process, spoken to the way a harness speaks to it: JSON-RPC, one message
 * per line on standard input and output. Every line it writes is kept, so a test can check that
 * nothing but the protocol ever reached standard output.
 */
function server(relay: string, home: string) {
  // AGENTHOP_BIN points this at a compiled binary, which is what people actually run.
  const binary = process.env.AGENTHOP_BIN;
  const child = spawn(binary ?? process.execPath, [...(binary ? [] : [launcher]), "mcp", "--relay", relay], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    detached: true,
  });
  started.push(child);
  const lines: string[] = [];
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let rest = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    rest += chunk;
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      lines.push(line);
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof message.id === "number") waiting.get(message.id)?.(message);
      } catch {
        // Kept in `lines`; the test says what it was.
      }
    }
  });
  let next = 1;
  const request = (method: string, params: unknown = {}) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 60_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    lines,
    async start() {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
      const answer = (await request("tools/call", { name, arguments: args })) as { result?: { content: { text: string }[] } };
      return answer.result?.content.map((part) => part.text).join("\n") ?? JSON.stringify(answer);
    },
  };
}

describe("agenthop mcp as a process", () => {
  it(
    "writes nothing but the protocol to standard output through a whole conversation",
    async () => {
      const relay = await startRelay();
      relays.push(relay);
      const dir = await mkdtemp(path.join(tmpdir(), "agenthop-mcp-stdio-"));
      const creator = server(relay.url, path.join(dir, "creator"));
      const joiner = server(relay.url, path.join(dir, "joiner"));
      await Promise.all([creator.start(), joiner.start()]);

      const created = await creator.call("agenthop_create", { background: "进程级的检查", accept_files: true });
      const code = created.match(/\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{26}/)?.[0];
      expect(code, created).toBeDefined();
      expect(await joiner.call("agenthop_join", { code })).toContain("进程级的检查");
      await joiner.call("agenthop_say", { text: "确认" });
      await creator.call("agenthop_wait", { timeout_seconds: 15 });
      await creator.call("agenthop_say", { text: "第一行\n第二行" });
      expect(await joiner.call("agenthop_wait", { timeout_seconds: 15 })).toContain("第一行\n第二行");
      await joiner.call("agenthop_working", { text: "在看" });
      await writeFile(path.join(dir, "a.txt"), "附件内容");
      expect(await joiner.call("agenthop_send_file", { path: path.join(dir, "a.txt") })).toContain("已送达");
      expect(await creator.call("agenthop_wait", { timeout_seconds: 15 })).toContain("对方 files");
      expect(await creator.call("agenthop_bye", { text: "再见" })).toContain("对话结束了");
      await joiner.call("agenthop_wait", { timeout_seconds: 15 });

      // The protocol and nothing else. One log line here would have broken the harness.
      for (const side of [creator, joiner]) {
        expect(side.lines.length).toBeGreaterThan(5);
        for (const line of side.lines) {
          let parsed: { jsonrpc?: string } | undefined;
          try {
            parsed = JSON.parse(line) as { jsonrpc?: string };
          } catch {
            parsed = undefined;
          }
          expect(parsed?.jsonrpc, `not JSON-RPC on standard output: ${line}`).toBe("2.0");
        }
      }
      // And the log still went where it always goes.
      const log = created.match(/日志：(\S+?\.create\.log)/)?.[1];
      expect(log && existsSync(log), created).toBe(true);
    },
    120_000,
  );
});
