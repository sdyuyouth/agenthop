import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startRelay } from "@agenthop/relay-node";
import { setLang } from "../src/lang.js";
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
      [
        "agenthop_accept",
        "agenthop_bye",
        "agenthop_contacts",
        "agenthop_create",
        "agenthop_decline",
        "agenthop_forget_contact",
        "agenthop_invite",
        "agenthop_join",
        "agenthop_save_contact",
        "agenthop_say",
        "agenthop_send_file",
        "agenthop_status",
        "agenthop_wait",
        "agenthop_working",
      ].sort(),
    );
    for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
    await relay.close();
  });

  it("declares all four hints, as booleans, on every tool", async () => {
    const { relay, creator } = await room();
    const { tools } = await creator.client.listTools();
    for (const tool of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe("boolean");
      }
    }
    const hints = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
    // What an agent (or a client that asks before acting) most needs to get right.
    expect(hints("agenthop_status")?.readOnlyHint).toBe(true);
    expect(hints("agenthop_contacts")?.readOnlyHint).toBe(true);
    expect(hints("agenthop_bye")?.destructiveHint).toBe(true);
    expect(hints("agenthop_forget_contact")?.destructiveHint).toBe(true);
    expect(hints("agenthop_say")?.readOnlyHint).toBe(false);
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

    expect((await joiner.call("agenthop_say", { text: "相符，我这边是后端" })).text).toContain("Channel open");
    const confirmed = await creator.call("agenthop_wait", { timeout_seconds: 10 });
    expect(confirmed.text).toContain("相符，我这边是后端");
    expect(confirmed.text).toContain("Your turn");

    // More than one line, as one message. The command line cannot do this; a tool argument can.
    expect((await creator.call("agenthop_say", { text: "两个问题：\n1. 页码从 0 还是 1 开始？\n2. 最大页长多少？" })).text).toContain("Delivered");
    const asked = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    expect(asked.text).toContain("两个问题：\n1. 页码从 0 还是 1 开始？\n2. 最大页长多少？");

    // A receipt does not end the other side's wait: it is not its turn.
    expect((await joiner.call("agenthop_working", { text: "收到，我去翻一下代码" })).isError).toBe(false);
    const meanwhile = await creator.call("agenthop_wait", { timeout_seconds: 3 });
    expect(meanwhile.text).toContain("收到，我去翻一下代码");
    expect(meanwhile.text).toContain("They are still working on it");

    await joiner.call("agenthop_say", { text: "从 1 开始，最大 100" });
    const answered = await creator.call("agenthop_wait", { timeout_seconds: 10 });
    expect(answered.text).toContain("从 1 开始，最大 100");
    expect(answered.text).toContain("Your turn");

    const left = await creator.call("agenthop_bye", { text: "谢谢" });
    expect(left.text).toContain("Conversation over");
    const heard = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    expect(heard.text).toContain("谢谢");
    expect(heard.text).toMatch(/goodbye|over/);
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
    expect(sent.text, sent.text).toContain("Delivered: error.log");
    const got = await creator.call("agenthop_wait", { timeout_seconds: 10 });
    expect(got.text).toContain("Your turn");
    const saved = got.text.match(/peer files: (\S+)/)?.[1];
    expect((await readFile(saved!)).equals(log), got.text).toBe(true);

    await writeFile(path.join(dir, "fix.diff"), "- retry(3)\n+ retry(5)\n");
    expect((await creator.call("agenthop_send_file", { path: path.join(dir, "fix.diff") })).text).toContain("Delivered");
    const back = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    expect(await readFile(back.text.match(/peer files: (\S+)/)![1]!, "utf8")).toBe("- retry(3)\n+ retry(5)\n");

    const missing = await joiner.call("agenthop_send_file", { path: path.join(dir, "nope.txt") });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("no such file");
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
    expect((await joiner.call("agenthop_status")).text).toContain("Step: talking");

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
    expect(old.text).toContain("missing its last part, the key");
    const nothing = await joiner.call("agenthop_say", { text: "你好" });
    expect(nothing.isError).toBe(true);
    await relay.close();
  });

  it("keeps a file's name as it was written, and treats a goodbye as the end at once", async () => {
    const { relay, creator, joiner } = await room();
    const created = await creator.call("agenthop_create", { background: "传个文件" });
    const code = created.text.match(/\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{26}/)?.[0];
    await joiner.call("agenthop_join", { code, accept_files: true });
    await joiner.call("agenthop_say", { text: "好" });
    await creator.call("agenthop_wait", { timeout_seconds: 10 });

    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-mcp-name-"));
    const file = path.join(dir, "报告 v2（终稿）.txt");
    await writeFile(file, "终稿");
    await creator.call("agenthop_send_file", { path: file });
    const got = await joiner.call("agenthop_wait", { timeout_seconds: 10 });
    const saved = got.text.match(/peer files: (.+\.txt)/)?.[1];
    expect(saved && path.basename(saved), got.text).toBe("报告 v2（终稿）.txt");
    expect(await readFile(saved!, "utf8")).toBe("终稿");

    // Refused by the tool already; the next wait does not tell it again.
    const over = await joiner.call("agenthop_say", { text: "x".repeat(64 * 1024 + 1) });
    expect(over.isError).toBe(true);
    await joiner.call("agenthop_say", { text: "下一句" });
    expect((await creator.call("agenthop_wait", { timeout_seconds: 10 })).text).toContain("下一句");
    await creator.call("agenthop_say", { text: "收到" });
    expect((await joiner.call("agenthop_wait", { timeout_seconds: 10 })).text).not.toContain("undelivered");

    await joiner.call("agenthop_bye", { text: "走了" });
    await creator.call("agenthop_wait", { timeout_seconds: 10 });
    // The creator lingers a moment after answering, so the joiner can read it. A line written
    // then would never go; it is refused rather than accepted into a queue nobody drains.
    const late = await creator.call("agenthop_say", { text: "还在吗" });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("is over");
    await relay.close();
  });

  it("answers each of several calls made at once about its own line", async () => {
    const { relay, creator, joiner } = await room();
    const created = await creator.call("agenthop_create", { background: "一起发" });
    const code = created.text.match(/\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{26}/)?.[0];
    await joiner.call("agenthop_join", { code });
    await joiner.call("agenthop_say", { text: "好" });
    await creator.call("agenthop_wait", { timeout_seconds: 10 });

    // Harnesses run tool calls in parallel. "Delivered" has to mean this line was delivered.
    // The one in the middle cannot go; answering it with the first line's outcome said it did.
    const texts = ["并发第 1 句", "并发第 2 句", "x".repeat(64 * 1024 + 1), "并发第 4 句", "并发第 5 句"];
    const replies = await Promise.all(texts.map((text) => joiner.call("agenthop_say", { text })));
    expect(replies.map((r) => r.isError)).toEqual([false, false, true, false, false]);
    expect(replies[2]!.text).toContain("over the 64 KiB limit for one line");
    expect(replies.filter((r) => !r.isError).every((r) => r.text.includes("Delivered"))).toBe(true);
    let heard = "";
    for (let i = 0; i < 10 && !heard.includes("并发第 5 句"); i++) heard += (await creator.call("agenthop_wait", { timeout_seconds: 5 })).text;
    expect([...heard.matchAll(/并发第 (\d) 句/g)].map((m) => m[1])).toEqual(["1", "2", "4", "5"]);
    await relay.close();
  });

  it("speaks Chinese to the agent once Chinese is chosen", async () => {
    setLang("zh");
    try {
      const { relay, creator } = await room();
      expect(creator.client.getInstructions()).toContain("agenthop 让你和另一台机器上的 agent 对话");
      const { tools } = await creator.client.listTools();
      expect(tools.find((tool) => tool.name === "agenthop_create")?.description).toContain("开一个房间");
      expect((await creator.call("agenthop_say", { text: "你好" })).text).toContain("现在没有对话");
      await relay.close();
    } finally {
      setLang("en");
    }
  });
});
