import { describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import { screenPartsHoldEverySpanWhole } from "../../test/orchestrator-text-invariants";
import { screenParts } from "./screen";

const RUNS = 100;

const PART_CHARS = 20_000;
const PART_STRIDE = 19_000;
const MAX_PARTS = 16;
const LONGEST_TEXT = 340_000;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function lettersFromSeed(length: number, seed: number): string {
  let state = seed >>> 0;
  const letters: string[] = Array.from({ length });
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    letters[index] = LETTERS[state % LETTERS.length]!;
  }
  return letters.join("");
}

const partEnds = Array.from({ length: 18 }, (_unused, part) => part * PART_STRIDE + PART_CHARS);

const longestScreenedText = (MAX_PARTS - 1) * PART_STRIDE + PART_CHARS;

const textLength = fc.oneof(
  fc.nat(LONGEST_TEXT),
  fc.integer({ min: longestScreenedText + 1, max: LONGEST_TEXT }),
  fc
    .tuple(fc.constantFrom(...partEnds), fc.integer({ min: -2, max: 2 }))
    .map(([end, offset]) => Math.max(0, end + offset)),
  fc.integer({ min: 0, max: 2 }),
);

const screenedText = fc
  .record({ length: textLength, seed: fc.integer() })
  .map(({ length, seed }) => lettersFromSeed(length, seed));

describe("screen invariants", () => {
  it(
    "every span of up to 1000 characters lies whole in one screen part",
    () => {
      let textsOfManyParts = 0;
      let textsPastThePartCap = 0;
      fc.assert(
        fc.property(screenedText, (text) => {
          if (text.length > PART_CHARS) textsOfManyParts++;
          if (text.length > longestScreenedText) textsPastThePartCap++;
          screenPartsHoldEverySpanWhole(text, screenParts(text));
        }),
        propertyRuns("screen parts hold every span whole", RUNS),
      );
      expect(textsOfManyParts).toBeGreaterThan(0);
      expect(textsPastThePartCap).toBeGreaterThan(0);
    },
    propertyTimeoutMs(20_000, RUNS),
  );
});
