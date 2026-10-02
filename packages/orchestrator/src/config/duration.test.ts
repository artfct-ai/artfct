import { describe, expect, it } from "bun:test";
import { Duration, parseDuration } from "./duration";

describe("parseDuration", () => {
  describe("a number", () => {
    it("counts whole seconds", () => {
      expect(parseDuration(5)).toBe(5000);
    });

    it("counts a fraction of a second", () => {
      expect(parseDuration(0.5)).toBe(500);
    });
  });

  describe("text with a unit suffix", () => {
    it("reads milliseconds", () => {
      expect(parseDuration("250ms")).toBe(250);
    });

    it("reads seconds", () => {
      expect(parseDuration("5s")).toBe(5000);
    });

    it("reads minutes", () => {
      expect(parseDuration("30m")).toBe(1_800_000);
    });

    it("reads hours", () => {
      expect(parseDuration("72h")).toBe(259_200_000);
    });

    it("reads days", () => {
      expect(parseDuration("2d")).toBe(172_800_000);
    });
  });

  describe("text with no unit suffix", () => {
    it("counts seconds", () => {
      expect(parseDuration("5")).toBe(5000);
    });
  });

  describe("text with decimals or whitespace", () => {
    it("accepts a decimal amount", () => {
      expect(parseDuration("1.5s")).toBe(1500);
    });

    it("ignores the spaces", () => {
      expect(parseDuration(" 2 m ")).toBe(120_000);
    });

    it("rounds to whole milliseconds", () => {
      expect(parseDuration("0.0005s")).toBe(1);
    });
  });

  describe("a duration of zero or less", () => {
    it("rejects the number zero", () => {
      expect(parseDuration(0)).toBeNull();
    });

    it("rejects a negative number", () => {
      expect(parseDuration(-5)).toBeNull();
    });

    it("rejects zero written as text", () => {
      expect(parseDuration("0")).toBeNull();
    });

    it("rejects zero with a unit", () => {
      expect(parseDuration("0s")).toBeNull();
    });

    it("rejects a negative amount with a unit", () => {
      expect(parseDuration("-5s")).toBeNull();
    });

    it("rejects a number that is not a number", () => {
      expect(parseDuration(Number.NaN)).toBeNull();
    });
  });

  describe("text that is not a duration", () => {
    it("rejects an empty string", () => {
      expect(parseDuration("")).toBeNull();
    });

    it("rejects a unit it does not know", () => {
      expect(parseDuration("5 weeks")).toBeNull();
    });

    it("rejects letters with no amount", () => {
      expect(parseDuration("abc")).toBeNull();
    });
  });
});

describe("Duration schema", () => {
  describe("a valid duration", () => {
    it("yields milliseconds for text with a unit", () => {
      expect(Duration.parse("30m")).toBe(1_800_000);
    });

    it("yields milliseconds for a number of seconds", () => {
      expect(Duration.parse(5)).toBe(5000);
    });
  });

  describe("text that is not a duration", () => {
    const result = Duration.safeParse("soon");

    it("fails", () => {
      expect(result.success).toBe(false);
    });

    it("quotes the input in the message", () => {
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("invalid duration: soon");
      }
    });
  });

  describe("a duration of zero", () => {
    it("fails", () => {
      expect(Duration.safeParse(0).success).toBe(false);
    });
  });
});
