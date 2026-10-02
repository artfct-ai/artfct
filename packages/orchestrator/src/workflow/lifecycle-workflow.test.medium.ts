import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bindWorkflow, listBindings } from "../db/bindings";
import { createDb } from "../db/client";
import { type FakeRuntime, seedTask } from "../../test/fake-runtime";
import { freshDurableRuntime } from "../../test/durable-runtime";
import { scenario } from "../../test/scenario";
import { completeWorkflow, failWorkflow } from "./lifecycle";

const SECOND_TASK = "wf_x.2";
const STAGES = ["design", "breakdown", "implement"];
const db = createDb(env.DB);

async function bindEverything(): Promise<void> {
  await bindWorkflow(db, { source: "chat_thread", external_id: "C1:1.0" }, "wf_x");
  await bindWorkflow(db, { source: "tracker_issue", external_id: "iss1" }, "wf_x");
  await bindWorkflow(db, { source: "code_branch", repo: "acme/app", branch: "b" }, "wf_x");
  await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 1 }, "wf_x");
  await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 2 }, "wf_other");
}

async function boundSources(): Promise<string[]> {
  const rows = await listBindings(db);
  return rows.map((row) => `${row.source}:${row.workflow_id}`).toSorted();
}

function planned(workflow: FakeRuntime, concurrency = 3): void {
  workflow.patchState({ stages: STAGES, concurrency, status: "running" });
}

describe("completeWorkflow", () => {
  describe("a workflow that reached its result", () => {
    const finished = scenario(freshDurableRuntime, async (workflow) => {
      planned(workflow);
      await completeWorkflow(workflow, "all done");
    });

    it("marks the workflow done", () =>
      finished((workflow) => {
        expect(workflow.state.status).toBe("done");
      }));

    it("posts the result", () =>
      finished((workflow) => {
        expect(workflow.posted).toEqual([{ type: "done", result: "all done" }]);
      }));

    it("logs the result", () =>
      finished((workflow) => {
        expect(workflow.lines).toContain("finished: all done");
      }));

    describe("with a binding of every kind on the workflow", () => {
      const unbound = scenario(freshDurableRuntime, async (workflow) => {
        planned(workflow);
        await bindEverything();
        await completeWorkflow(workflow, "all done");
      });

      it("drops the GitHub bindings and keeps the chat and issue ones", () =>
        unbound(async () => {
          expect(await boundSources()).toEqual([
            "chat_thread:wf_x",
            "code_pull:wf_other",
            "tracker_issue:wf_x",
          ]);
        }));
    });
  });
});

describe("failWorkflow", () => {
  describe("a workflow with one active task and one done task", () => {
    const failed = scenario(freshDurableRuntime, async (workflow) => {
      seedTask(workflow);
      seedTask(workflow, { task_id: SECOND_TASK, status: "done" });
      await failWorkflow(workflow, "stage x is not in the config");
    });

    it("marks the workflow failed", () =>
      failed((workflow) => {
        expect(workflow.state.status).toBe("failed");
      }));

    it("cancels the active task and leaves the done one", () =>
      failed((workflow) => {
        expect(workflow.store.tasks().map((task) => task.status)).toEqual(["cancelled", "done"]);
      }));

    it("posts the reason", () =>
      failed((workflow) => {
        expect(workflow.posted).toEqual([
          { type: "workflow_failed", reason: "stage x is not in the config" },
        ]);
      }));

    it("leaves no alarm scheduled", () =>
      failed((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));
  });

  describe("with a binding of every kind on the workflow", () => {
    const unbound = scenario(freshDurableRuntime, async (workflow) => {
      await bindEverything();
      await failWorkflow(workflow, "boom");
    });

    it("drops the GitHub bindings and keeps the chat and issue ones", () =>
      unbound(async () => {
        expect(await boundSources()).toEqual([
          "chat_thread:wf_x",
          "code_pull:wf_other",
          "tracker_issue:wf_x",
        ]);
      }));
  });
});
