import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { patchStageReviewers, seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import type { Applied } from "../types";
import { appliedForAgent } from "../../../test/applied-event";
import { applyArtifactEvent } from "./feedback";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const PR_URL = "https://github.com/acme/app/pull/1";

const OPENED: InboundEvent = {
  id: "evt-1",
  kind: "pr_event",
  actor: null,
  bindings: [],
  links: [],
  text: "",
  pull: { repo: "acme/app", number: 1, action: "opened", branch: "artfct/wf_x-1-fix" },
};

type Landed = { workflow: FakeRuntime; result: Applied };

function seedAuthor(workflow: FakeRuntime) {
  workflow.patchState({ repo: { full: "acme/app" } });
  return seedTask(workflow, { stage: "implement", branch: "artfct/wf_x-1-fix" });
}

const opened: Scenario<Landed> = (run) =>
  freshDurableRuntime(async (workflow) => {
    seedAuthor(workflow);
    const result = appliedForAgent(await applyArtifactEvent(workflow, OPENED));
    await run({ workflow, result });
  });

const late: Scenario<Landed> = (run) =>
  freshDurableRuntime(async (workflow) => {
    seedAuthor(workflow);
    workflow.store.updateTask(TASK, { status: "cancelled" });
    const result = appliedForAgent(await applyArtifactEvent(workflow, OPENED));
    await run({ workflow, result });
  });

const unreviewed: Scenario<Landed> = (run) =>
  freshDurableRuntime(async (workflow) => {
    seedAuthor(workflow);
    patchStageReviewers(workflow, []);
    const result = appliedForAgent(await applyArtifactEvent(workflow, OPENED));
    await run({ workflow, result });
  });

const twice = scenario(opened, async ({ workflow }) => {
  await applyArtifactEvent(workflow, OPENED);
});

describe("an artifact the host opened before the author printed it", () => {
  it("records it as the task artifact", () =>
    opened(({ workflow }) => {
      expect(workflow.store.artifact(JOB)).toMatchObject({ kind: "pull", external_url: PR_URL });
    }));

  it("starts the review, and says the humans wait for it", () =>
    opened(({ workflow, result }) => {
      expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      expect(result.notes).toEqual([expect.stringContaining("The review has it.")]);
    }));

  it("wakes nobody, since nothing needs saying yet", () =>
    opened(({ result }) => {
      expect(result.wake).toBe("none");
    }));

  describe("a pull request the host opened after the task was cancelled", () => {
    it("records it, because the pull request exists whatever the task did", () =>
      late(({ workflow }) => {
        expect(workflow.store.artifact(JOB)).toMatchObject({ kind: "pull", external_url: PR_URL });
      }));

    it("leaves the task cancelled rather than putting it back in review", () =>
      late(({ workflow }) => {
        expect(workflow.store.requireTask(TASK).status).toBe("cancelled");
      }));

    it("starts no reviewer on a task nobody is working", () =>
      late(({ workflow }) => {
        expect(workflow.store.activeRefinerRuns()).toEqual([]);
      }));

    it("gives the humans the pull request with the reason", () =>
      late(({ workflow }) => {
        const announced = workflow.posted.find((event) => event.type === "artifact_ready");
        expect(announced?.type === "artifact_ready" ? announced.text : "").toBe(
          `The agent review stopped: ${TASK} is cancelled. ${PR_URL}`,
        );
      }));

    it("tells the agent the humans have it, which is what happened", () =>
      late(({ result }) => {
        expect(result.notes).toEqual([expect.stringContaining("The humans have it.")]);
      }));
  });

  describe("the same pull request a second time", () => {
    it("starts no second review", () =>
      twice(({ workflow }) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      }));
  });

  describe("a stage that asks for no review", () => {
    it("gives the artifact to the humans at once", () =>
      unreviewed(({ workflow, result }) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
        expect(result.notes).toEqual([expect.stringContaining("The humans have it.")]);
      }));
  });
});
