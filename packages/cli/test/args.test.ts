import { describe, expect, it } from "vitest";
import { classifyInput, parseArgs } from "../src/args.js";

describe("arguments", () => {
  it("joins a room however the pairing code was written down", () => {
    for (const written of ["1720-spiny-patch-easel", "1720-SPINY-PATCH-EASEL", "1720 spiny patch easel"]) {
      expect(classifyInput(written.split(" "))).toEqual({ kind: "join", code: "1720-spiny-patch-easel" });
    }
  });

  it("refuses something that starts like a code instead of opening a room with it", () => {
    expect(() => classifyInput(["1720-spiny-patch"])).toThrow(/不像一个配对码/);
    expect(() => classifyInput(["1720-spiny-patch-easel-extra"])).toThrow(/不像一个配对码/);
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
