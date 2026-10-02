import { describe, expect, it } from "bun:test";
import { isExpiring } from "./expiry";

const now = Date.parse("2026-09-03T10:00:00.000Z");

describe("isExpiring", () => {
  describe("an expiry five minutes out", () => {
    const expiresAt = now + 5 * 60_000;

    it("is expiring inside a ten minute margin", () => {
      expect(isExpiring(expiresAt, now, 10 * 60_000)).toBe(true);
    });

    it("is not expiring inside a one minute margin", () => {
      expect(isExpiring(expiresAt, now, 60_000)).toBe(false);
    });
  });

  describe("an expiry exactly at the edge of the margin", () => {
    it("is expiring", () => {
      expect(isExpiring(now + 60_000, now, 60_000)).toBe(true);
    });
  });

  describe("an expiry already in the past", () => {
    it("is expiring with no margin at all", () => {
      expect(isExpiring(now - 1, now, 0)).toBe(true);
    });
  });
});
