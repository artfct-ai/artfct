import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { seedTask } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { planTools } from "./plan";

const call = { toolCallId: "call-1", messages: [], context: {} };

describe("fail_workflow", () => {
  describe("a workflow with one active task and one that is done", () => {
    let result: string;
    const failed = scenario(freshDurableRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1" });
      seedTask(workflow, { task_id: "wf_x.2", status: "done" });
      const { fail_workflow } = planTools(workflow);
      result = toolText(await fail_workflow.execute({ reason: "cannot build" }, call));
    });

    it("answers that the workflow failed", () =>
      failed(() => {
        expect(result).toBe("Workflow failed.");
      }));

    it("marks the workflow failed", () =>
      failed((workflow) => {
        expect(workflow.state.status).toBe("failed");
      }));

    it("cancels the active task", () =>
      failed((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("cancelled");
      }));

    it("leaves the finished task alone", () =>
      failed((workflow) => {
        expect(workflow.store.requireTask("wf_x.2").status).toBe("done");
      }));

    it("drops the sandbox of the active task", () =>
      failed((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual(["destroy wf_x.1"]);
      }));

    it("tells the channels why it failed", () =>
      failed((workflow) => {
        expect(workflow.posted).toEqual([{ type: "workflow_failed", reason: "cannot build" }]);
      }));

    it("leaves no alarm behind", () =>
      failed((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));
  });

  describe("a workflow that is done", () => {
    let refusal: string;
    const refused = scenario(freshDurableRuntime, async (workflow) => {
      workflow.patchState({ status: "done" });
      const { fail_workflow } = planTools(workflow);
      refusal = toolText(await fail_workflow.execute({ reason: "cannot build" }, call));
    });

    it("refuses and stays done", () =>
      refused((workflow) => {
        expect(refusal).toBe("The workflow is done. A finished workflow stays finished.");
        expect(workflow.state.status).toBe("done");
      }));
  });
});

describe("finish_workflow", () => {
  let result: string;
  const finished = scenario(freshDurableRuntime, async (workflow) => {
    const { finish_workflow } = planTools(workflow);
    result = toolText(await finish_workflow.execute({ result: "Shipped." }, call));
  });

  it("answers that the workflow finished", () =>
    finished(() => {
      expect(result).toBe("Workflow finished.");
    }));

  it("marks the workflow done", () =>
    finished((workflow) => {
      expect(workflow.state.status).toBe("done");
    }));

  it("posts the result to the channels", () =>
    finished((workflow) => {
      expect(workflow.posted).toEqual([{ type: "done", result: "Shipped." }]);
    }));

  it("logs the result", () =>
    finished((workflow) => {
      expect(workflow.lines).toContain("finished: Shipped.");
    }));

  describe("while one job runs and another is done", () => {
    let refusal: string;
    const refused = scenario(freshDurableRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", status: "in_review" });
      seedTask(workflow, { task_id: "wf_x.2", status: "done" });
      const { finish_workflow } = planTools(workflow);
      refusal = toolText(await finish_workflow.execute({ result: "Shipped." }, call));
    });

    it("refuses and names the running job and its status", () =>
      refused(() => {
        expect(refusal).toBe(
          "Job wf_x-1 is in_review. complete_job or cancel_job ends a job. Finish the workflow once no job runs.",
        );
      }));

    it("leaves the workflow open", () =>
      refused((workflow) => {
        expect(workflow.state.status).not.toBe("done");
      }));

    it("posts nothing", () =>
      refused((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("on a cancelled workflow", () => {
    let refusal: string;
    const refused = scenario(freshDurableRuntime, async (workflow) => {
      workflow.patchState({ status: "cancelled" });
      const { finish_workflow } = planTools(workflow);
      refusal = toolText(await finish_workflow.execute({ result: "Shipped." }, call));
    });

    it("refuses, since a finished workflow stays finished", () =>
      refused(() => {
        expect(refusal).toBe("The workflow is cancelled. A finished workflow stays finished.");
      }));

    it("stays cancelled", () =>
      refused((workflow) => {
        expect(workflow.state.status).toBe("cancelled");
      }));
  });
});
