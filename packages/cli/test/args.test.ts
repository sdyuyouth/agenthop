import { describe, expect, it } from "vitest";
import { classifyInput, parseArgs } from "../src/args.js";

describe("arguments", () => {
  it("joins a room however the pairing code was written down", () => {
    const written = [
      "1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3d",
      "1720-SPINY-PATCH-EASEL-K7F3Q2MBXZ4A6TU5WNHJY2PC3D",
      "1720 spiny patch easel k7f3q2mbxz4a6tu5wnhjy2pc3d",
    ];
    for (const text of written) {
      expect(classifyInput(text.split(" "))).toEqual({
        kind: "join",
        code: "1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3d",
      });
    }
  });

  it("tells a code from before the secret apart from one that was typed wrong", () => {
    // A code that stops after the words is a v0.3 code, or one that got cut short on the way
    // over. Calling that a typo would send someone looking for the wrong mistake.
    expect(() => classifyInput(["1720-spiny-patch-easel"])).toThrow(/少了最后一段密钥/);
    expect(() => classifyInput(["1720 spiny patch easel"])).toThrow(/少了最后一段密钥/);
  });

  it("refuses something that starts like a code instead of opening a room with it", () => {
    expect(() => classifyInput(["1720-spiny-patch"])).toThrow(/不像一个配对码/);
    expect(() => classifyInput(["1720-spiny-patch-easel-extra"])).toThrow(/不像一个配对码/);
    // Right shape, wrong alphabet, and one character short or long.
    expect(() => classifyInput(["1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc31"])).toThrow(/不像一个配对码/);
    expect(() => classifyInput(["1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3"])).toThrow(/不像一个配对码/);
    expect(() => classifyInput(["1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3dd"])).toThrow(/不像一个配对码/);
  });

  it("does not echo a nearly-right code back in full", () => {
    // The error goes to standard output, which is the agent's record of the session.
    const secret = "k7f3q2mbxz4a6tu5wnhjy2pc3dd";
    expect(() => classifyInput([`1720-spiny-patch-easel-${secret}`])).toThrow(/1720-spiny-patch-easel-…/);
    try {
      classifyInput([`1720-spiny-patch-easel-${secret}`]);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("treats ordinary text as the task background", () => {
    expect(classifyInput(["我要问对方", "一件事"])).toEqual({ kind: "create", hello: "我要问对方 一件事" });
  });

  it("rejects an unknown option rather than sending it as a hello", () => {
    expect(() => parseArgs(["--verison"])).toThrow(/不认识的选项/);
    expect(() => parseArgs(["--relay"])).toThrow(/要跟一个值/);
  });

  it("names the flags and commands older releases documented", () => {
    expect(() => parseArgs(["--agent", "claude -p"])).toThrow(/--agent 已经没有了/);
    expect(() => parseArgs(["--on-receive", "cat"])).toThrow(/--on-receive 已经没有了/);
    expect(() => classifyInput(["host"])).toThrow(/agenthop host 已经没有了/);
    expect(() => classifyInput(["send", "hi"])).toThrow(/已经没有了/);
  });

  it("reads --version and the commands that stay", () => {
    expect(parseArgs(["--version"]).flags.version).toBe(true);
    expect(classifyInput(["update"])).toEqual({ kind: "command", name: "update", words: [] });
    expect(classifyInput([])).toEqual({ kind: "help" });
  });
});
