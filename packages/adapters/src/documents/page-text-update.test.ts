import { describe, expect, it } from "bun:test";
import { applyPageTextEdits, planPageTextUpdate, type PageTextEdit } from "./page-text-update";

const MAX = 100;

function editsOf(before: string, after: string, maxEdits = MAX): PageTextEdit[] {
  const update = planPageTextUpdate({ before, after }, maxEdits);
  if ("whole" in update) throw new Error("expected edits");
  return update.edits;
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
