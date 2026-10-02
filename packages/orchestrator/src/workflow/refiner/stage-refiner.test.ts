import type { RefinerEntry, ReviewerEntry } from "../../config/refiner";
import type { Stage } from "../../config/stage";
import { describe, expect, it } from "bun:test";
import { JUDGE_ENTRY } from "../../../test/fake-runtime";
import { endsSegment, refinerAt, refinerCount, segmentStartOf } from "./stage-refiner";

const alignment = JUDGE_ENTRY;
const review: ReviewerEntry = { name: "review", mode: "findings", skill: "implement-review" };
const final: ReviewerEntry = { name: "final", mode: "findings", skill: "implement-review" };
const comments: RefinerEntry = { name: "comments", skill: "technical-writer" };
const naming: RefinerEntry = { name: "naming", skill: "code-cleaner" };

function stageOf(reviewers: ReviewerEntry[], polishers: RefinerEntry[]): Stage {
  return {
    name: "implement",
    artifact: "pull",
    branch: true,
    reviewers,
    polishers,
    author: { produce: { execution: "harness", skill: "implement" } },
    ending: "acceptance",
  };
}

describe("endsSegment", () => {
  it("is true on a judge entry", () => {
    expect(endsSegment(0, [alignment, review])).toBe(true);
  });

  it("is true on the last entry even when it is a findings entry", () => {
    expect(endsSegment(1, [alignment, review])).toBe(true);
  });

  it("is false on a plain entry with entries after it", () => {
    expect(endsSegment(0, [review, final])).toBe(false);
    expect(endsSegment(1, [review, review, final])).toBe(false);
  });
});

describe("segmentStartOf", () => {
  const three: ReviewerEntry[] = [alignment, review, final];

  it("opens the first segment at the first entry", () => {
    expect(segmentStartOf(0, three)).toBe(0);
  });

  it("opens the segment after a judge entry at the next entry", () => {
    expect(segmentStartOf(1, three)).toBe(1);
    expect(segmentStartOf(2, three)).toBe(1);
  });

  it("opens a segment of plain entries at its first entry", () => {
    expect(segmentStartOf(1, [review, review, final])).toBe(0);
    expect(segmentStartOf(2, [review, review, final])).toBe(0);
  });

  it("opens a one-entry list at zero", () => {
    expect(segmentStartOf(0, [review])).toBe(0);
  });
});

describe("refinerAt", () => {
  const stage = stageOf([alignment, review], [comments, naming]);

  it("reads a reviewer at its own index", () => {
    expect(refinerAt(stage, 0)).toEqual({ role: "reviewer", entry: alignment });
    expect(refinerAt(stage, 1)).toEqual({ role: "reviewer", entry: review });
  });

  it("keeps counting past the reviewers into the polishers", () => {
    expect(refinerAt(stage, 2)).toEqual({ role: "polisher", entry: comments });
    expect(refinerAt(stage, 3)).toEqual({ role: "polisher", entry: naming });
  });

  it("is null past the end of both lists", () => {
    expect(refinerAt(stage, 4)).toBeNull();
  });

  it("reads a polisher at index zero on a stage that declares no reviewer", () => {
    expect(refinerAt(stageOf([], [comments]), 0)).toEqual({ role: "polisher", entry: comments });
  });
});

describe("refinerCount", () => {
  it("counts both lists", () => {
    expect(refinerCount(stageOf([alignment, review], [comments]))).toBe(3);
  });

  it("is zero when the stage declares neither", () => {
    expect(refinerCount(stageOf([], []))).toBe(0);
  });
});
