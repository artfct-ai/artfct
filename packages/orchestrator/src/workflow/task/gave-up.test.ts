import { describe, expect, it } from "bun:test";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { AUTHOR_WORK, gaveUpAt, harnessGaveUp, GAVE_UP_PURPOSE } from "./gave-up";

const RUN = "wf_x.2";
const BLOCKED = "I could not check out the branch, so I did not review the change.";

function decisionsSay(workflow: FakeRuntime, gaveUp: number | Error): FakeDecisions {
  const decisions = new FakeDecisions(gaveUp instanceof Error ? gaveUp : { gave_up: gaveUp });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

function seedReviewer(workflow: FakeRuntime, summary: string) {
  seedTask(workflow);
  return seedTask(workflow, {
    task_id: RUN,
    role: "reviewer",
    job_id: "wf_x-1",
    summary,
  });
}

describe("gaveUpAt", () => {
  it("is true at the floor", () => {
    expect(gaveUpAt(0.7)).toBe(true);
  });

  it("is false when the decisions model is unsure", () => {
    expect(gaveUpAt(0.5)).toBe(false);
  });
});

describe("harnessGaveUp", () => {
  it("is true when the decisions model says the turn text gives up", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      expect(await harnessGaveUp(workflow, seedReviewer(workflow, BLOCKED))).toBe(true);
    }));

  it("is false when the decisions model says the work was done", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.1);
      expect(await harnessGaveUp(workflow, seedReviewer(workflow, "Review: approved"))).toBe(false);
    }));

  it("shows the decisions model the work and the turn text", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsSay(workflow, 0.9);
      await harnessGaveUp(workflow, seedReviewer(workflow, BLOCKED));
      expect(decisions.asked).toEqual([
        { work: "Review one artifact and report what the review found.", turn_text: BLOCKED },
      ]);
    }));

  it("shows the decisions model the work of the author's stage", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsSay(workflow, 0.9);
      const author = seedTask(workflow, { summary: BLOCKED });
      await harnessGaveUp(workflow, author);
      expect(decisions.asked).toEqual([
        { work: AUTHOR_WORK[workflow.stageForTask(author).artifact], turn_text: BLOCKED },
      ]);
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      await harnessGaveUp(workflow, seedReviewer(workflow, BLOCKED));
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([GAVE_UP_PURPOSE]);
    }));

  it("does not ask about a run that closed with no text", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsSay(workflow, 0.9);
      await harnessGaveUp(workflow, seedReviewer(workflow, ""));
      expect(decisions.asked).toEqual([]);
    }));

  it("is false when the decisions model fails", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, new Error("unavailable"));
      expect(await harnessGaveUp(workflow, seedReviewer(workflow, BLOCKED))).toBe(false);
    }));

  it("is false when the gateway carries no decisions model", () =>
    freshRuntime(async (workflow) => {
      expect(await harnessGaveUp(workflow, seedReviewer(workflow, BLOCKED))).toBe(false);
    }));
});
