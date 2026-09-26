import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startRelay } from "@agenthop/relay-node";
import { startMcpServer } from "../src/mcp.js";

type Result = { text: string; isError: boolean };

/** One side: an MCP server with its own home, and a client talking to it the way a harness would. */
async function side(relay: string, dir: string, name: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ relay, home: path.join(dir, name) }, serverSide);
  const client = new Client({ name, version: "0" });
  await client.connect(clientSide);
  return {
    client,
    async call(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
      const result = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
    },
  };
}

async function room() {
  const dir = await mkdtemp(path.join(tmpdir(), "agenthop-mcp-"));
  const relay = await startRelay();
  const creator = await side(relay.url, dir, "creator");
  const joiner = await side(relay.url, dir, "joiner");
  return { relay, creator, joiner };
}

describe("agenthop as an MCP server", () => {
  it("lists its tools with descriptions an agent can act on", async () => {
    const { relay, creator } = await room();
    const { tools } = await creator.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["agenthop_bye", "agenthop_create", "agenthop_join", "agenthop_say", "agenthop_send_file", "agenthop_status", "agenthop_wait", "agenthop_working"].sort(),
    );
    for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
    await relay.close();
  });

  it("carries a whole conversation without anyone writing to a process's standard input", async () => {
    const { relay, creator, joiner } = await room();

    const created = await creator.call("agenthop_create", { background: "我想问一下接口的分页参数" });
    expect(created.isError).toBe(false);
    const code = created.text.match(/\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{26}/)?.[0];
    expect(code, created.text).toBeDefined();

    // Agents wrap codes in backticks; the join tool takes that as it comes.
    const joined = await joiner.call("agenthop_join", { code: `\`${code}\`` });
    expect(joined.text).toContain("我想问一下接口的分页参数");

    expect((await joiner.call("agenthop_say", { text: "相符，我这边是后端" })).text).toContain("通道打开了");
    const confirmed = await creator.call("agenthop_wait", { timeout_seconds: 10 });
    expect(confirmed.text).toContain("相符，我这边是后端");
    expect(confirmed.text).toContain("轮到你了");

    // More than one line, as one message. The command line cannot do this; a tool argument can.
    expect((await creator.call("agenthop_say", { text: "两个问题：\n1. 页码从 0 还是 1 开始？\n2. 最大页长多少？" })).text).toContain("已送达");
    const asked = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    expect(asked.text).toContain("两个问题：\n1. 页码从 0 还是 1 开始？\n2. 最大页长多少？");

    // A receipt does not end the other side's wait: it is not its turn.
    expect((await joiner.call("agenthop_working", { text: "收到，我去翻一下代码" })).isError).toBe(false);
    const meanwhile = await creator.call("agenthop_wait", { timeout_seconds: 3 });
    expect(meanwhile.text).toContain("收到，我去翻一下代码");
    expect(meanwhile.text).toContain("对方还在处理");

    await joiner.call("agenthop_say", { text: "从 1 开始，最大 100" });
    const answered = await creator.call("agenthop_wait", { timeout_seconds: 10 });
    expect(answered.text).toContain("从 1 开始，最大 100");
    expect(answered.text).toContain("轮到你了");

    const left = await creator.call("agenthop_bye", { text: "谢谢" });
    expect(left.text).toContain("对话结束了");
    const heard = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    expect(heard.text).toContain("谢谢");
    expect(heard.text).toMatch(/告别|结束/);
    await relay.close();
  });

  it("sends files both ways when both sides asked to keep them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-mcp-files-"));
    const { relay, creator, joiner } = await room();
    const code = (await creator.call("agenthop_create", { background: "要交换两份文件", accept_files: true })).text.match(/\d{4}-\S+/)?.[0];
    await joiner.call("agenthop_join", { code, accept_files: true });
    await joiner.call("agenthop_say", { text: "确认" });
    await creator.call("agenthop_wait", { timeout_seconds: 10 });

    const log = Buffer.from("ERROR 2026-09-26 连接超时\n  at retry (net.ts:42)\n");
    await writeFile(path.join(dir, "error.log"), log);
    const sent = await joiner.call("agenthop_send_file", { path: path.join(dir, "error.log") });
    expect(sent.text, sent.text).toContain("已送达：error.log");
    const got = await creator.call("agenthop_wait", { timeout_seconds: 10 });
    expect(got.text).toContain("轮到你了");
    const saved = got.text.match(/对方 files：(\S+)/)?.[1];
    expect((await readFile(saved!)).equals(log), got.text).toBe(true);

    await writeFile(path.join(dir, "fix.diff"), "- retry(3)\n+ retry(5)\n");
    expect((await creator.call("agenthop_send_file", { path: path.join(dir, "fix.diff") })).text).toContain("已送达");
    const back = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    expect(await readFile(back.text.match(/对方 files：(\S+)/)![1]!, "utf8")).toBe("- retry(3)\n+ retry(5)\n");

    const missing = await joiner.call("agenthop_send_file", { path: path.join(dir, "nope.txt") });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("找不到这个文件");
    await joiner.call("agenthop_bye");
    await relay.close();
  });

  it("keeps words and commands apart", async () => {
    const { relay, creator, joiner } = await room();
    const code = (await creator.call("agenthop_create", { background: "背景" })).text.match(/\d{4}-\S+/)?.[0];
    await joiner.call("agenthop_join", { code });
    await joiner.call("agenthop_say", { text: "确认" });

    // Through `say` a goodbye is an error pointing at the right tool, not an accidental ending.
    const slipped = await joiner.call("agenthop_say", { text: "/bye" });
    expect(slipped.isError).toBe(true);
    expect(slipped.text).toContain("agenthop_bye");
    expect((await joiner.call("agenthop_status")).text).toContain("对话中");

    // One conversation at a time per server.
    const second = await creator.call("agenthop_create", { background: "另一件事" });
    expect(second.isError).toBe(true);
    await joiner.call("agenthop_bye");
    await relay.close();
  });

  it("says what is wrong with a code instead of opening a room", async () => {
    const { relay, joiner } = await room();
    const old = await joiner.call("agenthop_join", { code: "1720-spiny-patch-easel" });
    expect(old.isError).toBe(true);
    expect(old.text).toContain("少了最后一段密钥");
    const nothing = await joiner.call("agenthop_say", { text: "你好" });
    expect(nothing.isError).toBe(true);
    await relay.close();
  });
});
