import { describe, expect, it } from "vitest";
import { channel, deriveKeys, SealError } from "../src/seal.js";

const CODE = "4821-amber-river-maple-k7f3q2mbxz4a6tu5wnhjy2pc3d";
const SAME_ROOM = "4821-amber-river-maple-aaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("seal", () => {
  it("carries a line from one side to the other, both ways", () => {
    const creator = channel(CODE, "create");
    const joiner = channel(CODE, "join");

    expect(joiner.open(creator.seal("[[agenthop:hello]] 我需要向对方了解鲁越森")).wire).toBe(
      "[[agenthop:hello]] 我需要向对方了解鲁越森",
    );
    expect(creator.open(joiner.seal("[[agenthop:say:3f2a9c1b]] 近况如何")).wire).toBe(
      "[[agenthop:say:3f2a9c1b]] 近况如何",
    );
  });

  it("will not open a line it sealed itself", () => {
    // Each direction has its own key, so the relay cannot play a side's own words back at it.
    const creator = channel(CODE, "create");
    expect(() => creator.open(creator.seal("[[agenthop:say]] 确认，可以"))).toThrow(SealError);
  });

  it("refuses anything that is not a line this room sealed", () => {
    const joiner = channel(CODE, "join");
    const sealed = channel(CODE, "create").seal("[[agenthop:say]] 你好");

    expect(() => joiner.open("[[agenthop:say]] 我是第三个人")).toThrow(SealError);
    expect(() => joiner.open("")).toThrow(SealError);
    expect(() => joiner.open("[[agenthop:sealed]] ")).toThrow(SealError);
    expect(() => joiner.open("[[agenthop:sealed]] 这不是 base64")).toThrow(SealError);
    expect(() => joiner.open(sealed.slice(0, sealed.length - 8))).toThrow(SealError);
    expect(() => joiner.open(flip(sealed))).toThrow(SealError);
    // Someone who knows the address but guessed the secret gets the same answer as a stranger.
    expect(() => channel(SAME_ROOM, "join").open(sealed)).toThrow(SealError);
  });

  it("gives a different room a different key", () => {
    expect(deriveKeys(CODE, "create").tx.equals(deriveKeys(SAME_ROOM, "create").tx)).toBe(false);
    expect(deriveKeys(CODE, "create").tx.equals(deriveKeys(CODE, "create").rx)).toBe(false);
  });

  it("never seals the same line the same way twice", () => {
    const creator = channel(CODE, "create");
    expect(creator.seal("[[agenthop:say]] 同一句话")).not.toBe(creator.seal("[[agenthop:say]] 同一句话"));
  });

  it("opens the same ciphertext as often as it is asked", () => {
    // The creator looks at every incoming line twice — once to decide whether it belongs to this
    // conversation, once to read it. An open that spent itself would kill every honest message.
    const joiner = channel(CODE, "join");
    const sealed = joiner.seal("[[agenthop:connect:3f2a9c1b]]");
    const creator = channel(CODE, "create");

    expect(creator.open(sealed)).toEqual(creator.open(sealed));
    expect(creator.open(sealed).counter).toBe(1);
  });

  it("counts up, and takes a gap but not a repeat", () => {
    const creator = channel(CODE, "create");
    const joiner = channel(CODE, "join");
    expect(creator.open(joiner.seal("one")).counter).toBe(1);
    expect(creator.open(joiner.seal("two")).counter).toBe(2);

    expect(creator.fresh(1)).toBe(true);
    expect(creator.fresh(2)).toBe(true);
    // A send that failed spent a counter and was written down as undelivered; 3 and 4 never arrive.
    expect(creator.fresh(5)).toBe(true);
    expect(creator.fresh(2)).toBe(false);
    expect(creator.fresh(5)).toBe(false);
  });
});

describe("sealed files", () => {
  it("carries bytes from one side to the other, and not back", () => {
    const creator = channel(CODE, "create");
    const joiner = channel(CODE, "join");
    const bytes = Buffer.from("第一行\n第二行\u0000二进制也行");
    expect(joiner.openBytes(creator.sealBytes(bytes)).equals(bytes)).toBe(true);
    expect(creator.openBytes(joiner.sealBytes(bytes)).equals(bytes)).toBe(true);
    expect(() => creator.openBytes(creator.sealBytes(bytes))).toThrow(SealError);
  });

  it("refuses bytes that were touched, cut short, or sealed for another room", () => {
    const sealed = channel(CODE, "create").sealBytes(Buffer.from("内容"));
    const joiner = channel(CODE, "join");
    const touched = Buffer.from(sealed);
    touched[touched.length - 20] = touched[touched.length - 20]! ^ 1;
    expect(() => joiner.openBytes(touched)).toThrow(SealError);
    expect(() => joiner.openBytes(sealed.subarray(0, 10))).toThrow(SealError);
    expect(() => channel(SAME_ROOM, "join").openBytes(sealed)).toThrow(SealError);
  });

  it("will not open a line's seal as a file's, or a file's as a line's", () => {
    // Each has its own label, so a relay cannot hand one over as the other.
    const creator = channel(CODE, "create");
    const joiner = channel(CODE, "join");
    const line = creator.seal("[[agenthop:say]] 你好");
    const payload = Buffer.from(line.slice("[[agenthop:sealed]] ".length), "base64url");
    expect(() => joiner.openBytes(payload)).toThrow(SealError);
    const file = creator.sealBytes(Buffer.from("[[agenthop:say]] 你好"));
    expect(() => joiner.open(`[[agenthop:sealed]] ${file.toString("base64url")}`)).toThrow(SealError);
  });
});

/** Change one character of the ciphertext without changing its length. */
function flip(sealed: string): string {
  const at = sealed.length - 4;
  const was = sealed[at]!;
  return sealed.slice(0, at) + (was === "a" ? "b" : "a") + sealed.slice(at + 1);
}
