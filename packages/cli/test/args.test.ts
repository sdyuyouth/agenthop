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

  describe("a code the way agents actually pass it along", () => {
    const CODE = "1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3d";
    const joins = { kind: "join", code: CODE };

    it("in backticks, quotes or brackets", () => {
      // Agents wrap codes in backticks constantly. A backtick in front used to make the whole
      // thing task text, and the command quietly opened a second room instead of joining.
      for (const written of [`\`${CODE}\``, `"${CODE}"`, `'${CODE}'`, `「${CODE}」`, `(${CODE})`, `${CODE}.`, `${CODE}。`]) {
        expect(classifyInput([written]), written).toEqual(joins);
      }
    });

    it("as the whole waiting line, with or without its timestamp", () => {
      expect(classifyInput([`local waiting ${CODE}`])).toEqual(joins);
      expect(classifyInput(["local", "waiting", CODE])).toEqual(joins);
      expect(classifyInput([`2026-09-24T10:33:58.235+08:00 local waiting ${CODE}`])).toEqual(joins);
    });

    it("with the secret broken across a line by the terminal", () => {
      expect(classifyInput(["1720-spiny-patch-easel-k7f3q2mbxz4a6tu5\nwnhjy2pc3d"])).toEqual(joins);
      expect(classifyInput(["1720-spiny-patch-easel-k7f3q2mbxz4a6tu5", "wnhjy2pc3d"])).toEqual(joins);
    });

    it("in full-width characters", () => {
      expect(classifyInput(["１７２０－ｓｐｉｎｙ－ｐａｔｃｈ－ｅａｓｅｌ－ｋ７ｆ３ｑ２ｍｂｘｚ４ａ６ｔｕ５ｗｎｈｊｙ２ｐｃ３ｄ"])).toEqual(joins);
    });

    it("followed by a few words of instruction", () => {
      expect(classifyInput([CODE, "请加入"])).toEqual(joins);
    });

    it("wrapped and followed by instruction at once", () => {
      // Found by running the binary, not by these tests: each half was covered, the pair was not.
      for (const written of [[`\`${CODE}\``, "请加入"], [`「${CODE}」请加入`], [`"${CODE}"，麻烦加入一下`], [`(${CODE}) 这是码`]]) {
        expect(classifyInput(written), written.join(" ")).toEqual(joins);
      }
    });
  });

  describe("task text that merely starts like a code", () => {
    it("stays task text when it starts with a year", () => {
      // These used to be read as mistyped codes and refused outright.
      expect(classifyInput(["2026 年的季度计划要对一下"])).toEqual({ kind: "create", hello: "2026 年的季度计划要对一下" });
      expect(classifyInput(["2024-Q3 销售数据对账"])).toEqual({ kind: "create", hello: "2024-Q3 销售数据对账" });
    });

    it("stays task text when a code only appears in the middle", () => {
      const hello = "请用 1720-spiny-patch-easel-k7f3q2mbxz4a6tu5wnhjy2pc3d 之外的码";
      expect(classifyInput([hello])).toEqual({ kind: "create", hello });
    });
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
