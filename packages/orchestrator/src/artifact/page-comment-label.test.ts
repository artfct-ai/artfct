import { describe, expect, it } from "bun:test";
import { labeledPageCommentIds, pageCommentLabel } from "./page-comment-label";

describe("pageCommentLabel", () => {
  it("names the comment id", () => {
    expect(pageCommentLabel("2f1c-9a")).toBe("[comment 2f1c-9a]");
  });
});

describe("labeledPageCommentIds", () => {
  it("reads back each labeled id in order, each once", () => {
    const text = [
      `- ${pageCommentLabel("c-2")} Ann: Rename it.`,
      `- ${pageCommentLabel("c-1")} Bo: Why?`,
      `- ${pageCommentLabel("c-2")} Ann: Again.`,
    ].join("\n");
    expect(labeledPageCommentIds(text)).toEqual(["c-2", "c-1"]);
  });

  it("reads an empty list from a text without labels", () => {
    expect(labeledPageCommentIds("Name the identity provider.")).toEqual([]);
  });
});
