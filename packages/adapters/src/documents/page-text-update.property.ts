import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../test/property-runs";
import { applyPageTextEdits, planPageTextUpdate, type PageTextEdit } from "./page-text-update";

const MAX = 100;
const RUNS = 100;

function editsOf(before: string, after: string, maxEdits = MAX): PageTextEdit[] {
  const update = planPageTextUpdate({ before, after }, maxEdits);
  if ("whole" in update) throw new Error("expected edits");
  return update.edits;
}

function matchCount(text: string, find: string): number {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) count += 1;
  return count;
}

describe("planPageTextUpdate on any pair of pages", () => {
  const line = fc.constantFrom("# Goal", "TBD", "", "- item", "Ship it.", "## Risks", "x");
  const page = fc.array(line, { minLength: 1, maxLength: 12 }).map((lines) => lines.join("\n"));
  const pages = fc.tuple(
    page.filter((text) => text.trim() !== ""),
    page,
    fc.integer({ min: 1, max: 4 }),
  );

  it(
    "turns the text read into the revised text when applied in order",
    () => {
      fc.assert(
        fc.property(pages, ([before, after, maxEdits]) => {
          const applied = applyPageTextEdits(before, editsOf(before, after, maxEdits));
          expect(applied).toEqual({ text: after });
        }),
        propertyRuns("page text update reaches the revised text", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "plans edits that each match once, in the text read and after the edits before them",
    () => {
      fc.assert(
        fc.property(pages, ([before, after, maxEdits]) => {
          let current = before;
          for (const edit of editsOf(before, after, maxEdits)) {
            expect(matchCount(before, edit.find)).toBe(1);
            expect(matchCount(current, edit.find)).toBe(1);
            current = current.replace(edit.find, () => edit.replace);
          }
        }),
        propertyRuns("page text update edits match once", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "stays within the edit limit",
    () => {
      fc.assert(
        fc.property(pages, ([before, after, maxEdits]) => {
          expect(editsOf(before, after, maxEdits).length).toBeLessThanOrEqual(maxEdits);
        }),
        propertyRuns("page text update edit limit", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "covers only changed lines and one anchor per insertion when every line is distinct",
    () => {
      const operation = fc.constantFrom("keep", "keep", "change", "delete", "insert");
      fc.assert(
        fc.property(fc.array(operation, { minLength: 1, maxLength: 15 }), (operations) => {
          const before: string[] = [];
          const after: string[] = [];
          let insertions = 0;
          operations.forEach((step, index) => {
            if (step === "insert") {
              after.push(`new ${index}.`);
              insertions += 1;
              return;
            }
            before.push(`old ${index}.`);
            if (step === "keep") after.push(`old ${index}.`);
            if (step === "change") after.push(`changed ${index}.`);
          });
          if (!before.length) return;
          const edits = editsOf(before.join("\n"), after.join("\n"));
          const coveredKeptLines = edits
            .flatMap((edit) => edit.find.split("\n"))
            .filter((covered) => after.includes(covered));
          expect(coveredKeptLines.length).toBeLessThanOrEqual(insertions);
        }),
        propertyRuns("page text update distinct lines", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
