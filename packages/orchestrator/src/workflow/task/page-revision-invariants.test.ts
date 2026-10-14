import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { freshRuntime } from "../../../test/fresh-runtime";
import { PAGE_REVISION_INVARIANTS } from "../../../test/page-revision-invariants";
import {
  pageRevisionWorld,
  runRevisionAction,
  type ModelPlan,
  type PageRevisionWorld,
  type RevisionAction,
} from "../../../test/page-revision-world";

const NUM_RUNS = 150;

const plans: fc.Arbitrary<ModelPlan> = fc.record({
  steps: fc.array(
    fc.record({
      lineIndex: fc.nat({ max: 20 }),
      kind: fc.constantFrom("change" as const, "delete" as const, "insert_after" as const),
    }),
    { maxLength: 5 },
  ),
  skippedReply: fc.option(fc.nat({ max: 3 }), { freq: 3 }),
  strayReply: fc.constantFrom(false, false, false, true),
});

const actions: fc.Arbitrary<RevisionAction> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("comment" as const),
      lineIndex: fc.option(fc.nat({ max: 20 }), { freq: 5 }),
      text: fc.constantFrom("Why?", "Rename this.", "Cut this line."),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("fail_next" as const),
      method: fc.constantFrom(
        "readPageContent" as const,
        "replyToComment" as const,
        "updatePageContent" as const,
      ),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant("revise" as const), plan: plans }), weight: 3 },
);

const reached = { removedSentCommentLine: 0, failedReply: 0, written: 0 };

function countReached(world: PageRevisionWorld): void {
  for (const revision of world.revisions) {
    if (revision.pageAfter !== revision.pageBefore) reached.written += 1;
    if (revision.answer && revision.repliesPosted < revision.answer.replyCount) {
      reached.failedReply += 1;
    }
  }
  const sentIds = new Set(world.sent.map((sent) => sent.commentId));
  const removedLines = world.documents.events.flatMap((event) =>
    event.kind === "lines_removed" ? event.lineIds : [],
  );
  reached.removedSentCommentLine += world.documents.allPersonComments
    .filter((comment) => sentIds.has(comment.id))
    .filter((comment) => comment.lineId !== null && removedLines.includes(comment.lineId)).length;
}

describe("the page revision invariants, pending owner approval", () => {
  it("hold after every action of any sequence", async () => {
    const property = fc.asyncProperty(
      fc.integer({ min: 1, max: 8 }),
      fc.array(actions, { minLength: 1, maxLength: 12 }),
      (lineCount, sequence) =>
        freshRuntime(async (workflow) => {
          const world = await pageRevisionWorld(workflow, lineCount);
          for (const action of sequence) {
            await runRevisionAction(world, action);
            for (const invariant of PAGE_REVISION_INVARIANTS) invariant(world);
          }
          countReached(world);
        }),
    );
    await fc.assert(property, { numRuns: NUM_RUNS });
    expect(reached.written).toBeGreaterThan(0);
    expect(reached.failedReply).toBeGreaterThan(0);
    expect(reached.removedSentCommentLine).toBeGreaterThan(0);
  });
});
