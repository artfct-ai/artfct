import { describe, expect, it } from "bun:test";
import { textHoldsPassage } from "./passage";

describe("textHoldsPassage", () => {
  it("finds a passage inside the text", () => {
    expect(textHoldsPassage("The rollout plan names no owner.", "plan names no owner")).toBe(true);
  });

  it("does not find words the text does not hold", () => {
    expect(textHoldsPassage("The rollout plan names no owner.", "names the owner")).toBe(false);
  });

  it("matches a passage quoted from markdown against plain text", () => {
    expect(
      textHoldsPassage(
        "Store the id in jobs.issue_id and read it on start.",
        "Store the id in `jobs.issue_id` and **read** it",
      ),
    ).toBe(true);
  });

  it("matches the text of a markdown link", () => {
    expect(
      textHoldsPassage("See the glossary for terms.", "See [the glossary](https://x.test)"),
    ).toBe(true);
  });

  it("ignores case, curly quotes, and line breaks", () => {
    expect(textHoldsPassage("It says “done” when\nthe job ends.", 'it says "done" when the')).toBe(
      true,
    );
  });

  it("matches nothing for a passage of markdown marks alone", () => {
    expect(textHoldsPassage("Any text at all.", "**")).toBe(false);
  });
});
