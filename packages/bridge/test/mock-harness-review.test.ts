import { describe, expect, it } from "bun:test";
import { nextReview, reviewedPageId } from "./mock-harness-review";

const PAGE_ID = "64657369676e00000000000000000000";

const REVIEW_PROMPT = [
  "You are reviewing a change you did not write, and you have not seen the reasoning behind it.",
  "",
  "## The artifact",
  `https://www.notion.so/acme/design-${PAGE_ID}`,
].join("\n");

describe("reviewedPageId", () => {
  it("reads the page id out of a review prompt", () => {
    expect(reviewedPageId(REVIEW_PROMPT)).toBe(PAGE_ID);
  });

  it("ignores a prompt that is not a review", () => {
    expect(reviewedPageId(`Write the design.\nhttps://www.notion.so/acme/x-${PAGE_ID}`)).toBeNull();
  });

  it("ignores a review of something that is not a page", () => {
    expect(reviewedPageId("You are reviewing https://github.com/acme/app/pull/7")).toBeNull();
  });
});

describe("nextReview", () => {
  it("files findings when nothing has been filed", () => {
    expect(nextReview([])).toStartWith("Review: findings");
  });

  it("files findings when the page only holds other comments", () => {
    expect(nextReview(["Please add the owner."])).toStartWith("Review: findings");
  });

  it("approves once a review already stands", () => {
    expect(nextReview(["Review: findings\n- Rollout"])).toStartWith("Review: approved");
  });
});
