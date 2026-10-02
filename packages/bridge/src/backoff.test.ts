import { describe, expect, it } from "bun:test";
import { backoffDelay } from "./backoff";

describe("backoffDelay", () => {
  describe("the first attempts", () => {
    it("starts at 500ms", () => {
      expect(backoffDelay(0)).toBe(500);
    });

    it("doubles on the next attempt", () => {
      expect(backoffDelay(1)).toBe(1000);
    });

    it("keeps doubling", () => {
      expect(backoffDelay(3)).toBe(4000);
    });
  });

  describe("attempts past the ceiling", () => {
    it("caps at 30s", () => {
      expect(backoffDelay(6)).toBe(30_000);
    });

    it("stays at the cap", () => {
      expect(backoffDelay(20)).toBe(30_000);
    });
  });
});
