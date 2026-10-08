import { describe, expect, it } from "bun:test";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import type { TaskRow } from "../store/tasks";
import { authorAskedForReview, REVIEW_AGAIN_PURPOSE, reviewAgainAt } from "./review-again";

const CLOSING_TEXT = "Renamed the provider. Run the reviewers again.";

function decisionsSay(workflow: FakeRuntime, reviewAgain: number | Error): FakeDecisions {
  const decisions = new FakeDecisions(
    reviewAgain instanceof Error ? reviewAgain : { review_again: reviewAgain },
  );
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

function authorWithClosingText(workflow: FakeRuntime): TaskRow {
  const author = seedTask(workflow);
  workflow.store.updateTask(author.task_id, { summary: CLOSING_TEXT });
  return workflow.store.requireTask(author.task_id);
}

describe("reviewAgainAt", () => {
  it("is true at the floor", () => {
    expect(reviewAgainAt(0.7)).toBe(true);
  });

  it("is false when the decisions model is unsure", () => {
    expect(reviewAgainAt(0.5)).toBe(false);
  });
});

describe("authorAskedForReview", () => {
  it("shows the decisions model the author's closing text", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsSay(workflow, 0.9);
      await authorAskedForReview(workflow, authorWithClosingText(workflow));
      expect(decisions.asked).toEqual([{ closing_text: CLOSING_TEXT }]);
    }));

  it("is true when the decisions model says yes", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      expect(await authorAskedForReview(workflow, authorWithClosingText(workflow))).toBe(true);
    }));

  it("is false when the decisions model says no", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.1);
      expect(await authorAskedForReview(workflow, authorWithClosingText(workflow))).toBe(false);
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      await authorAskedForReview(workflow, authorWithClosingText(workflow));
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([REVIEW_AGAIN_PURPOSE]);
    }));

  it("is null when the decisions model fails", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, new Error("unavailable"));
      expect(await authorAskedForReview(workflow, authorWithClosingText(workflow))).toBeNull();
    }));
});
