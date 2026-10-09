import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { ScriptedFailure, type Action } from "../../../test/fake-model";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { runAgentTurn } from "./turn";

function turnThatCalls(status: "planning" | "running", call: Action) {
  return scenario(freshDurableRuntime, async (workflow: FakeRuntime) => {
    workflow.gatewayInstance = new FakeGateway();
    workflow.patchState({ status });
    workflow.modelInstance = new ScriptedFailure([call]);
    workflow.transcript.enqueue("Task wf_x.1 finished.", "task_result");
    await runAgentTurn(workflow);
  });
}

describe("a turn of a workflow in planning", () => {
  describe("that calls finish_workflow", () => {
    const finished = turnThatCalls("planning", "finish");

    it("leaves the workflow in planning", () =>
      finished((workflow) => {
        expect(workflow.state.status).toBe("planning");
      }));

    it("posts no result", () =>
      finished((workflow) => {
        expect(workflow.posted.map((event) => event.type)).not.toContain("done");
      }));
  });

  describe("that calls fail_workflow", () => {
    const failed = turnThatCalls("planning", "fail");

    it("leaves the workflow in planning", () =>
      failed((workflow) => {
        expect(workflow.state.status).toBe("planning");
      }));
  });
});

describe("a turn of a running workflow that calls finish_workflow", () => {
  const finished = turnThatCalls("running", "finish");

  it("ends the workflow", () =>
    finished((workflow) => {
      expect(workflow.state.status).toBe("done");
    }));
});
