import { describe, expect, it } from "bun:test";
import { notionRichText } from "./rich-text";

describe("notionRichText", () => {
  it("keeps a short text in one item", () => {
    expect(notionRichText("Renamed the goal.")).toEqual([
      { type: "text", text: { content: "Renamed the goal." } },
    ]);
  });

  it("splits a long text into items of at most 2000 characters, in order", () => {
    const items = notionRichText("a".repeat(2000) + "b".repeat(5));
    expect(items.map((item) => item.text.content)).toEqual(["a".repeat(2000), "bbbbb"]);
  });
});
