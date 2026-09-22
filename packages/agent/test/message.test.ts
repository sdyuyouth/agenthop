import { describe, expect, it } from "vitest";
import { messageFromParts, partsFromMessage, type HopMessage } from "../src/message.js";

describe("message", () => {
  it("keeps text and file bytes the same in both directions", () => {
    const original: HopMessage = {
      text: "the interface stays JSON-RPC",
      files: [{ name: "note.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("hello") }],
    };
    const restored = messageFromParts(partsFromMessage(original));
    expect(restored.text).toBe(original.text);
    expect(restored.files).toEqual(original.files);
  });
});
