import type { ModelMessage } from "ai";
import { describe, expect, it } from "bun:test";
import type { TranscriptRow } from "./transcript";
import { cutIndex, estimatedTokens } from "./transcript-size";

function row(id: number, message: ModelMessage): TranscriptRow {
  return { id, at: "", message };
}

const user = (id: number): TranscriptRow => row(id, { role: "user", content: "u" });

const assistant = (id: number): TranscriptRow => row(id, { role: "assistant", content: "a" });

describe("cutIndex", () => {
  describe("six rows that alternate user and assistant", () => {
    it("cuts at the latest user message", () => {
      const rows = [user(1), assistant(2), user(3), assistant(4), user(5), assistant(6)];
      expect(cutIndex(rows)).toBe(4);
    });
  });

  describe("rows that end on a user message", () => {
    it("cuts at that message", () => {
      expect(cutIndex([user(1), assistant(2), user(3)])).toBe(2);
    });
  });

  describe("rows with no user message after the first", () => {
    it("keeps every row", () => {
      expect(cutIndex([user(1), assistant(2), assistant(3)])).toBe(0);
    });
  });
});

describe("estimatedTokens", () => {
  it("counts four characters as one token", () => {
    expect(estimatedTokens("x".repeat(4000))).toBe(1000);
  });

  it("rounds a remainder up", () => {
    expect(estimatedTokens("abcde")).toBe(2);
  });

  it("counts no tokens in no text", () => {
    expect(estimatedTokens("")).toBe(0);
  });
});
