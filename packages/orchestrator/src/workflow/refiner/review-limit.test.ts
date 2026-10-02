import { describe, expect, it } from "bun:test";
import { seedPullRequestTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import { startRefiner } from "./loop";
import { reviewLimitReached, unreviewedRevisionNote } from "./review-limit";

const JOB = "wf_x-1";

function review(findings: number) {
  return {
    kind: "review" as const,
    revision: "abc123",
    blocking: false,
    summary: "",
    findings: Array.from({ length: findings }, () => ({
      location: "src/login.ts",
      body: "Fix it.",
    })),
  };
}

async function finishedReviewerRun(workflow: FakeRuntime, findings: number): Promise<void> {
  await startRefiner(workflow, workflow.store.authorTaskOf(JOB), 0);
  const runs = workflow.store.refinerRunsOf(JOB);
  workflow.store.updateTask(runs.at(-1)!.task_id, {
    status: "done",
    result: review(findings),
    started_at: new Date(Date.UTC(2026, 0, 1, runs.length)).toISOString(),
  });
}

function lastRun(workflow: FakeRuntime) {
  return workflow.store.refinerRunsOf(JOB).at(-1)!;
}

const twoRuns: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
  seedPullRequestTask(workflow);
  await finishedReviewerRun(workflow, 1);
  await finishedReviewerRun(workflow, 1);
});

const threeRuns = scenario(twoRuns, (workflow) => finishedReviewerRun(workflow, 2));

describe("reviewLimitReached", () => {
  it("is false while the reviewer ran fewer times than the limit", () =>
    twoRuns((workflow) => {
      expect(reviewLimitReached(workflow, lastRun(workflow))).toBe(false);
    }));

  it("is true once the reviewer ran as often as the limit", () =>
    threeRuns((workflow) => {
      expect(reviewLimitReached(workflow, lastRun(workflow))).toBe(true);
    }));
});

describe("unreviewedRevisionNote", () => {
  it("is null on an artifact no reviewer ran on", () =>
    freshRuntime((workflow) => {
      seedPullRequestTask(workflow);
      expect(unreviewedRevisionNote(workflow, JOB)).toBeNull();
    }));

  it("is null below the limit, where the author or the agent chose to hand on", () =>
    twoRuns((workflow) => {
      expect(unreviewedRevisionNote(workflow, JOB)).toBeNull();
    }));

  it("names the limit when the last review at the limit left findings", () =>
    threeRuns((workflow) => {
      expect(unreviewedRevisionNote(workflow, JOB)).toBe(
        "The author answered the latest review findings. The agent review reached its limit of 3 runs, so that revision did not get a review.",
      );
    }));

  it("is null when the last review at the limit left nothing", () =>
    scenario(twoRuns, (workflow) => finishedReviewerRun(workflow, 0))((workflow) => {
      expect(unreviewedRevisionNote(workflow, JOB)).toBeNull();
    }));
});
