import type { RefinerEntry, ReviewerEntry } from "../../config/refiner";
import type { Stage } from "../../config/stage";
import { describe, expect, it } from "bun:test";
import { JUDGE_ENTRY, seedPullRequestTask } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import type { TaskRow } from "../store/tasks";
import {
  endsSegment,
  nextEntryToRun,
  refinerAt,
  refinerCount,
  segmentEndOf,
  segmentReviews,
  segmentStartOf,
} from "./stage-refiner";

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

describe("segmentEndOf", () => {
  it("ends a segment of plain entries at its last entry", () => {
    expect(segmentEndOf(0, [review, final])).toBe(1);
  });

  it("ends a segment at its judge entry", () => {
    expect(segmentEndOf(0, [review, alignment, final])).toBe(1);
    expect(segmentEndOf(2, [review, alignment, final])).toBe(2);
  });
});

function withRuns(test: (runAt: (index: number, revision: string | null) => TaskRow) => void) {
  return freshRuntime((workflow) => {
    seedPullRequestTask(workflow);
    const author = workflow.store.authorTaskOf("wf_x-1");
    let sequence = 0;
    test((index, revision) => {
      sequence += 1;
      return {
        ...author,
        task_id: `wf_x.run-${sequence}`,
        role: "reviewer",
        refiner_index: index,
        result:
          revision === null
            ? null
            : { kind: "review", revision, blocking: false, summary: "", findings: [] },
      };
    });
  });
}

describe("segmentReviews", () => {
  it("reads the latest run of each entry", () =>
    withRuns((runAt) => {
      const runs = [runAt(0, "a"), runAt(1, "b"), runAt(0, "b")];
      expect(segmentReviews(runs, 0, 1).map(({ review: filed }) => filed.revision)).toEqual([
        "b",
        "b",
      ]);
    }));

  it("leaves out an entry whose latest run filed nothing", () =>
    withRuns((runAt) => {
      const runs = [runAt(0, "a"), runAt(1, "a"), runAt(1, null)];
      expect(segmentReviews(runs, 0, 1).map((filed) => filed.refiner_index)).toEqual([0]);
    }));
});

describe("nextEntryToRun", () => {
  const entries = [review, alignment, final];

  it("starts at the first entry that did not review the revision", () =>
    withRuns((runAt) => {
      const runs = [runAt(0, "a"), runAt(2, "b")];
      expect(nextEntryToRun({ entries, runs, from: 0, revision: "b" })).toBe(0);
      expect(nextEntryToRun({ entries, runs, from: 0, revision: "a" })).toBe(1);
    }));

  it("passes over a judge that ruled on any revision", () =>
    withRuns((runAt) => {
      const ruled = {
        ...runAt(1, null),
        result: { kind: "ruling" as const, revision: "a", ruling: "approved" as const },
      };
      const runs = [runAt(0, "b"), ruled];
      expect(nextEntryToRun({ entries, runs, from: 0, revision: "b" })).toBe(2);
    }));

  it("runs past the reviewers when every one had its say", () =>
    withRuns((runAt) => {
      const runs = [runAt(0, "b"), runAt(1, "b"), runAt(2, "b")];
      expect(nextEntryToRun({ entries: [review, final], runs, from: 1, revision: "b" })).toBe(2);
    }));

  it("runs every entry on a revision the host cannot say", () =>
    withRuns((runAt) => {
      const runs = [runAt(0, "b"), runAt(2, "b")];
      expect(nextEntryToRun({ entries, runs, from: 0, revision: null })).toBe(0);
    }));
});
