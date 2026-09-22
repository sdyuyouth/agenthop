import { describe, expect, it } from "vitest";
import { Talk } from "../src/talk.js";

describe("talk queue", () => {
  it("keeps later messages behind the current ask, then delivers them in order", () => {
    const talk = new Talk();
    const ask = talk.push({ id: "ask", kind: "ask", from: "peer", text: "do this", files: [] });
    expect(ask.event).toBe("current");
    expect(ask.at).toContain("T");
    expect(ask.from).toBe("peer");
    expect(talk.push({ id: "a", kind: "say", from: "peer", text: "one", files: [] }).event).toBe("queued");
    expect(talk.push({ id: "b", kind: "say", from: "peer", text: "two", files: [] }).event).toBe("queued");
    expect(talk.push({ id: "c", kind: "ask", from: "host", text: "three", files: [] }).event).toBe("queued");
    const extra = talk.supplement({ id: "extra", from: "host", text: "also tests", files: [] });
    expect(extra.event).toBe("supplement");
    expect(extra.current).toBe("ask");

    const done = talk.answer("ask", { from: "host", text: "done", files: [] });
    expect(done.event).toBe("done");
    expect(done.id).toBe("ask");
    const followed = talk.since(done.seq);
    expect(followed.map((event) => [event.event, event.id])).toEqual([
      ["said", "a"],
      ["said", "b"],
      ["current", "c"],
    ]);
    expect(talk.snapshot()).toEqual({ current: "c", pending: [] });
  });

  it("rejects a supplement or an answer when it is not the current task", () => {
    const talk = new Talk();
    expect(() => talk.supplement({ id: "x", from: "host", text: "nope", files: [] })).toThrow(/no current task/);
    talk.push({ id: "ask", kind: "ask", from: "peer", text: "do this", files: [] });
    talk.push({ id: "next", kind: "ask", from: "peer", text: "later", files: [] });
    expect(() => talk.answer("next", { from: "host", text: "too soon", files: [] })).toThrow(/not the current task/);
  });
});
