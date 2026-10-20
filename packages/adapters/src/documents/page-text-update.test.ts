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

describe("planPageTextUpdate", () => {
  it("writes the whole text on a page without text", () => {
    expect(planPageTextUpdate({ before: " \n", after: "# Goal" }, MAX)).toEqual({
      whole: "# Goal",
    });
  });

  it("plans no edit when nothing changed", () => {
    expect(editsOf("# Goal\nShip it.", "# Goal\nShip it.")).toEqual([]);
  });

  it("replaces only the line that changed", () => {
    expect(editsOf("# Goal\nShip it.\n## Risks", "# Goal\nShip it today.\n## Risks")).toEqual([
      { find: "Ship it.", replace: "Ship it today." },
    ]);
  });

  it("deletes a line with the line break after it", () => {
    expect(editsOf("# Goal\nDrop me.\n## Risks", "# Goal\n## Risks")).toEqual([
      { find: "Drop me.\n", replace: "" },
    ]);
  });

  it("deletes the last line with the line break before it", () => {
    expect(editsOf("# Goal\nShip it.\nDrop me.", "# Goal\nShip it.")).toEqual([
      { find: "\nDrop me.", replace: "" },
    ]);
  });

  it("anchors an insertion on the line before it", () => {
    expect(editsOf("# Goal\n## Risks", "# Goal\nShip it.\n## Risks")).toEqual([
      { find: "# Goal", replace: "# Goal\nShip it." },
    ]);
  });

  it("anchors an insertion at the top on the line after it", () => {
    expect(editsOf("# Goal\n## Risks", "Intro.\n# Goal\n## Risks")).toEqual([
      { find: "# Goal", replace: "Intro.\n# Goal" },
    ]);
  });

  it("takes in a neighboring line when the changed line repeats on the page", () => {
    expect(editsOf("## A\nTBD\n## B\nTBD", "## A\nTBD\n## B\nDone")).toEqual([
      { find: "## B\nTBD", replace: "## B\nDone" },
    ]);
  });

  it("keeps separate edits for changes far apart", () => {
    expect(editsOf("a\nb\nc\nd\ne", "A\nb\nc\nd\nE")).toEqual([
      { find: "a", replace: "A" },
      { find: "e", replace: "E" },
    ]);
  });

  it("merges the closest edits to stay within the limit", () => {
    expect(editsOf("a\nb\nc\nd\ne\nf", "A\nB2\nc\nd\ne\nF", 1)).toEqual([
      { find: "a\nb\nc\nd\ne\nf", replace: "A\nB2\nc\nd\ne\nF" },
    ]);
  });

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

describe("applyPageTextEdits", () => {
  it("applies the edits in order", () => {
    expect(
      applyPageTextEdits("a\nb", [
        { find: "a", replace: "A" },
        { find: "b", replace: "B" },
      ]),
    ).toEqual({ text: "A\nB" });
  });

  it("names an edit that does not match", () => {
    expect(applyPageTextEdits("a\nb", [{ find: "c", replace: "C" }])).toEqual({
      error: "an edit matches the page 0 times: c",
    });
  });

  it("names an edit that matches more than once", () => {
    expect(applyPageTextEdits("a\na", [{ find: "a", replace: "A" }])).toEqual({
      error: "an edit matches the page 2 times: a",
    });
  });
});
