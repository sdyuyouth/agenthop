import { describe, expect, it } from "vitest";
import { oneLine } from "../src/session.js";

describe("one event, one line", () => {
  it("turns every kind of line break into a visible mark", () => {
    expect(oneLine("a\nb\r\nc\rd\u2028e\u2029f\u0085g")).toBe("a↵b↵c↵d↵e↵f↵g");
  });

  it("drops what would drive the terminal instead of being read", () => {
    expect(oneLine("red\u001b[31m text\u0007 bell\u0000")).toBe("red[31m text bell");
    // Direction overrides can make a line read as something other than what it says.
    expect(oneLine("abc\u202edcba\u2066x\u2069")).toBe("abcdcbax");
  });

  it("leaves ordinary text alone, joiners and marks included", () => {
    const text = "👩‍👩‍👧 é(é) שלום مرحبا 中文";
    expect(oneLine(text)).toBe(text);
    expect(oneLine("tab\there")).toBe("tab here");
  });
});
