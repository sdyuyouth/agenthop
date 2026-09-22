import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectAnswer } from "../src/files.js";

describe("DirExecutor file access", () => {
  it("returns a hosted note and refuses a path that leaves the directory", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "agenthop-"));
    const root = path.join(parent, "notes");
    await mkdir(root);
    await writeFile(path.join(root, "NOTES.md"), "interface decision: keep JSON-RPC\n");
    await writeFile(path.join(parent, "secret.txt"), "TOP-SECRET");

    await expect(collectAnswer(root, "NOTES.md 里关于接口的决定是什么")).resolves.toContain("keep JSON-RPC");
    await expect(collectAnswer(root, "../secret.txt")).resolves.toBe("denied");
    await expect(collectAnswer(root, "../secret.txt")).resolves.not.toContain("TOP-SECRET");
    await expect(collectAnswer(undefined, "hello")).resolves.toBe("hello");
  });
});
