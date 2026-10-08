import { describe, expect, it } from "bun:test";
import { estimatedTokens } from "./transcript-size";

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
