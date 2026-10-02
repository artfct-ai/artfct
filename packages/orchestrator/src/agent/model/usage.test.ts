import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "bun:test";
import { callUsage, stepsUsage } from "./usage";

function usage(input: number, output: number, raw?: LanguageModelUsage["raw"]): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
    totalTokens: input + output,
    raw,
  };
}

describe("callUsage", () => {
  describe("usage with a cost in the raw object", () => {
    it("reads the cost OpenRouter reports", () => {
      expect(callUsage(usage(120, 30, { prompt_tokens: 120, cost: 0.0042 }))).toEqual({
        input_tokens: 120,
        output_tokens: 30,
        cost_usd: 0.0042,
      });
    });
  });

  describe("usage without a usable cost", () => {
    it("costs zero when the provider reports none", () => {
      expect(callUsage(usage(1, 2)).cost_usd).toBe(0);
    });

    it("costs zero when the cost is not a number", () => {
      expect(callUsage(usage(1, 2, { cost: "free" })).cost_usd).toBe(0);
    });

    it("costs zero when the cost is NaN", () => {
      expect(callUsage(usage(1, 2, { cost: Number.NaN })).cost_usd).toBe(0);
    });
  });

  describe("usage that reports no tokens", () => {
    it("counts the missing tokens as zero", () => {
      const empty = { ...usage(0, 0), inputTokens: undefined, outputTokens: undefined };
      expect(callUsage(empty)).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    });
  });
});

describe("stepsUsage", () => {
  describe("a call of two steps", () => {
    const steps = [
      { usage: usage(10, 2, { cost: 0.01 }) },
      { usage: usage(20, 3, { cost: 0.02 }) },
    ];

    it("sums the tokens and the cost", () => {
      expect(stepsUsage(steps)).toEqual({ input_tokens: 30, output_tokens: 5, cost_usd: 0.03 });
    });
  });

  describe("a call with no step", () => {
    it("is zero", () => {
      expect(stepsUsage([])).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    });
  });
});
