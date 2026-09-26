import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRelay } from "@agenthop/relay-node";
import { addressOf } from "@agenthop/tunnel";
import { readQueue, roomBase } from "../src/send.js";
import { failures, pair, resetFailures, waitForText } from "./harness.js";

beforeEach(() => {
  resetFailures();
});

afterEach(() => {
  expect(failures.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([]);
});

const SECRET = "这是一份只有两端能读的内容 1f3a9c";

async function fixture(dir: string, name: string, body: string | Buffer) {
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

describe("sending a file", () => {
  for (const from of ["joiner", "creator"] as const) {
    const to = from === "joiner" ? "creator" : "joiner";
    it(`goes from the ${from} to the ${to}, sealed, and arrives byte for byte`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "agenthop-files-"));
      const relay = await startRelay();
      const p = await pair(relay.url, dir, { creator: { keepFiles: true }, joiner: { keepFiles: true } });
      const bytes = Buffer.concat([Buffer.from(SECRET), Buffer.from([0, 1, 2, 255])]);
      const file = await fixture(dir, "机密-plan.txt", bytes);
      (from === "joiner" ? p.joinerLines : p.creatorLines).push(`/file ${file}`);

      const home = to === "creator" ? p.creatorHome : p.joinerHome;
      await waitForText(home, "peer files");
      const log = await p.log(to);
      const saved = log.match(/peer files (\S+)/)?.[1];
      expect(saved, log).toBeDefined();
      expect((await readFile(saved!)).equals(bytes)).toBe(true);
      expect(await p.log(from)).toMatch(/local files .*plan\.txt/);

      // What anyone holding the room address can read carries neither the contents nor the name.
      const queue = JSON.stringify(await readQueue(roomBase(relay.url, addressOf(p.code))));
      expect(queue).not.toContain(SECRET);
      expect(queue).not.toContain(Buffer.from(SECRET).toString("base64"));
      expect(queue).not.toContain("plan.txt");
      expect(queue).not.toContain("inbox");

      p.joinerLines.push("/bye");
      await Promise.all([p.creator, p.joiner]);
      await relay.close();
    });
  }

  it("names the file but keeps it off the disk unless asked", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-files-"));
    const relay = await startRelay();
    const p = await pair(relay.url, dir);
    p.joinerLines.push(`/file ${await fixture(dir, "notes.md", "# 笔记")}`);
    await waitForText(p.creatorHome, "peer files");
    expect(await p.log("creator")).toMatch(/peer files 对方带了 1 个文件，没有保存.*notes\.md/);
    p.joinerLines.push("/bye");
    await Promise.all([p.creator, p.joiner]);
    await relay.close();
  });

  it("says why a file did not go, and carries on", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-files-"));
    const relay = await startRelay();
    const p = await pair(relay.url, dir);
    p.joinerLines.push(`/file ${path.join(dir, "no-such-file.txt")}`);
    p.joinerLines.push(`/file ${await fixture(dir, "big.bin", Buffer.alloc(512 * 1024 + 1))}`);
    p.joinerLines.push(`/file ${dir}`);
    p.joinerLines.push("文件之后的一句");
    await waitForText(p.creatorHome, "peer say 文件之后的一句");
    const log = await p.log("joiner");
    expect(log).toMatch(/local undelivered \/file .*no-such-file\.txt（找不到这个文件）/);
    expect(log).toMatch(/local undelivered \/file .*big\.bin（超过单个文件 512 KiB 的上限）/);
    expect(log).toMatch(/local undelivered \/file .*（这是一个目录，只能发单个文件）/);
    p.joinerLines.push("/bye");
    await Promise.all([p.creator, p.joiner]);
    await relay.close();
  });

  it("carries the largest file there is room for", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agenthop-files-"));
    const relay = await startRelay();
    const p = await pair(relay.url, dir, { creator: { keepFiles: true }, joiner: { keepFiles: true } });
    const bytes = Buffer.alloc(512 * 1024, 7);
    p.joinerLines.push(`/file ${await fixture(dir, "full.bin", bytes)}`);
    p.creatorLines.push(`/file ${await fixture(dir, "full-back.bin", bytes)}`);
    await waitForText(p.creatorHome, "peer files");
    await waitForText(p.joinerHome, "peer files");
    for (const side of ["creator", "joiner"] as const) {
      const saved = (await p.log(side)).match(/peer files (\S+)/)?.[1];
      expect((await readFile(saved!)).equals(bytes), side).toBe(true);
    }
    p.joinerLines.push("/bye");
    await Promise.all([p.creator, p.joiner]);
    await relay.close();
  });
});
