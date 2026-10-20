import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime, unstartedDurableRuntime } from "../../../test/durable-runtime";
import { ScriptedFailure, type Action } from "../../../test/fake-model";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import { runAgentTurn } from "./turn";

function turnThatCalls(started: Scenario<FakeRuntime>, call: Action) {
  return scenario(started, async (workflow: FakeRuntime) => {
    workflow.gatewayInstance = new FakeGateway();
    workflow.modelInstance = new ScriptedFailure([call]);
    workflow.transcript.enqueue("Task wf_x.1 finished.", "task_result");
    await runAgentTurn(workflow);
  });
}

describe("a turn of a workflow that has not started", () => {
  describe("that calls finish_workflow", () => {
    const finished = turnThatCalls(unstartedDurableRuntime, "finish");

    it("leaves the workflow new", () =>
      finished((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("new");
      }));

    it("posts no result", () =>
      finished((workflow) => {
        expect(workflow.posted.map((event) => event.type)).not.toContain("done");
      }));
  });

  describe("that calls fail_workflow", () => {
    const failed = turnThatCalls(unstartedDurableRuntime, "fail");

    it("leaves the workflow new", () =>
      failed((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("new");
      }));
  });
});

describe("a turn of a running workflow that calls finish_workflow", () => {
  const finished = turnThatCalls(freshDurableRuntime, "finish");

  it("ends the workflow", () =>
    finished((workflow) => {
      expect(workflow.store.requireWorkflowRow().status).toBe("done");
    }));
});
