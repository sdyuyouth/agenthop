import { describe, expect, it } from "vitest";
import { brief, parseWire, sayWire, stamp } from "../src/session.js";

describe("log line", () => {
  it("stamps local time with its offset, not UTC", () => {
    const at = stamp(new Date(2026, 8, 23, 9, 54, 53, 729));
    expect(at).toMatch(/^2026-09-23T09:54:53\.729[+-]\d{2}:\d{2}$/);
    expect(at).not.toContain("Z");
  });
});

describe("wire", () => {
  it("carries the id of the side that joined, and reads lines that have none", () => {
    expect(parseWire(sayWire("abc123", "在吗"))).toEqual({ kind: "say", id: "abc123", text: "在吗" });
    expect(parseWire("[[agenthop:say]] 在吗")).toEqual({ kind: "say", id: "", text: "在吗" });
    expect(parseWire("[[agenthop:connect]]")).toEqual({ kind: "connect", id: "", text: "" });
    expect(parseWire("[[agenthop:bye:abc123]]")).toEqual({ kind: "bye", id: "abc123", text: "" });
    expect(parseWire("随便一句话")).toEqual({ kind: "other", id: "", text: "随便一句话" });
  });
});

describe("a refused line in the log", () => {
  it("stays one line however much the stranger sent", () => {
    expect(brief("短的一句")).toBe("短的一句");
    expect(brief("多\n行\n文本")).toBe("多 行 文本");
    const flood = brief("x".repeat(5000));
    expect(flood.length).toBeLessThan(120);
    expect(flood).toContain("共 5000 字");
  });
});
