import { describe, expect, it } from "vitest";
import { Talk } from "../src/talk.js";

describe("talk log", () => {
  it("keeps both sides in one order and hands back only what is new", () => {
    const talk = new Talk();
    const first = talk.push({ id: "a", from: "peer", text: "one", files: [] });
    expect(first.seq).toBe(1);
    expect(first.at).toContain("T");
    talk.push({ id: "b", from: "host", text: "two", files: [] });
    talk.push({ id: "c", from: "peer", text: "three", files: [] });
    expect(talk.since(0).map((event) => [event.from, event.text])).toEqual([
      ["peer", "one"],
      ["host", "two"],
      ["peer", "three"],
    ]);
    expect(talk.since(2).map((event) => event.text)).toEqual(["three"]);
    expect(talk.since(3)).toEqual([]);
  });
});
