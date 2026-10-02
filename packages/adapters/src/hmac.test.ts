import { describe, expect, it } from "bun:test";
import { hmacSha256Hex, timingSafeEqual } from "./hmac";

describe("hmacSha256Hex", () => {
  it("matches the RFC 4231 test vector", async () => {
    const hex = await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
    expect(hex).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("timingSafeEqual", () => {
  describe("two equal strings", () => {
    it("reports them equal", () => {
      expect(timingSafeEqual("abc", "abc")).toBe(true);
    });
  });

  describe("two strings that differ", () => {
    it("reports a changed character unequal", () => {
      expect(timingSafeEqual("abc", "abd")).toBe(false);
    });

    it("reports a shorter string unequal", () => {
      expect(timingSafeEqual("abc", "ab")).toBe(false);
    });
  });
});
