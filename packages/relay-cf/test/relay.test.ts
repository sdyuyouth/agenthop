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
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (
        await SELF.fetch("http://example.com/r/4444-acid-acorn-acre/", {
          headers: { "cf-connecting-ip": "203.0.113.20" },
        })
      ).status;
    }
    expect(last).toBe(429);
  });
});
