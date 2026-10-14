import { describe, expect, it } from "bun:test";
import { notionRichText } from "./rich-text";

describe("notionRichText", () => {
  it("keeps a short text in one item", () => {
    expect(notionRichText("Looks right.")).toEqual([
      { type: "text", text: { content: "Looks right." } },
    ]);
  });

  it("splits a long text into items of at most 2000 characters, in order", () => {
    const text = `${"a".repeat(2000)}${"b".repeat(2000)}c`;
    expect(notionRichText(text)).toEqual([
      { type: "text", text: { content: "a".repeat(2000) } },
      { type: "text", text: { content: "b".repeat(2000) } },
      { type: "text", text: { content: "c" } },
    ]);
  });
});
