import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("workers relay", () => {
  it("answers 404 for a room with no host", async () => {
    const response = await SELF.fetch("http://example.com/r/1111-acid-acorn-acre/", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    expect(response.status).toBe(404);
  });

  it("rate limits repeated lookups of a missing code", async () => {
    // The counter resets on the minute, so a run that starts near a boundary gets a fresh
    // allowance part way through. Two allowances is the worst case; keep asking until one of
    // them runs out.
    let refused = false;
    for (let i = 0; i < 130 && !refused; i++) {
      const response = await SELF.fetch("http://example.com/r/4444-acid-acorn-acre/", {
        headers: { "cf-connecting-ip": "203.0.113.20" },
      });
      refused = response.status === 429;
    }
    expect(refused).toBe(true);
  });
});
