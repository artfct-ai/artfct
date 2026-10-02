import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../test/fresh-runtime";
import { seedTask } from "../../test/fake-runtime";
import { scenario } from "../../test/scenario";
import { taskCostText } from "./cost";
import type { FakeRuntime } from "../../test/fake-runtime";

function recordTokens(workflow: FakeRuntime, purpose: string, inputTokens: number): void {
  workflow.store.recordModelUsage({
    purpose,
    model: "m",
    input_tokens: inputTokens,
    output_tokens: 0,
    cost_usd: 0,
  });
}

describe("model usage", () => {
  describe("two model calls of different purposes", () => {
    const recorded = scenario(freshRuntime, (workflow) => {
      workflow.store.recordModelUsage({
        purpose: "orchestrator",
        model: "openrouter/x-ai/grok-4.6",
        input_tokens: 1200,
        output_tokens: 80,
        cost_usd: 0.03,
      });
      workflow.store.recordModelUsage({
        purpose: "summarize",
        model: "openrouter/minimax/minimax-m3",
        input_tokens: 300,
        output_tokens: 40,
        cost_usd: 0.001,
      });
    });

    it("stores the calls in the order they were made", () =>
      recorded((workflow) => {
        expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([
          "orchestrator",
          "summarize",
        ]);
      }));

    it("stores the tokens and the cost of a call", () =>
      recorded((workflow) => {
        expect(workflow.store.modelUsage()[0]).toMatchObject({
          input_tokens: 1200,
          cost_usd: 0.03,
        });
      }));

    it("adds the calls to the workflow total", () =>
      recorded((workflow) => {
        expect(workflow.store.workflowCost()).toBeCloseTo(0.031);
      }));
  });
});

describe("lastTurnInputTokens", () => {
  describe("two turn calls with a prompt call after them", () => {
    const recorded = scenario(freshRuntime, (workflow) => {
      recordTokens(workflow, "orchestrator", 1200);
      recordTokens(workflow, "orchestrator", 4800);
      recordTokens(workflow, "compact", 9000);
    });

    it("reads the last turn call, not the prompt that followed it", () =>
      recorded((workflow) => {
        expect(workflow.store.lastTurnInputTokens()).toBe(4800);
      }));
  });

  describe("a workflow whose turns have reported nothing", () => {
    it("counts no tokens", () =>
      freshRuntime((workflow) => {
        expect(workflow.store.lastTurnInputTokens()).toBe(0);
      }));
  });
});

describe("workflowCost", () => {
  describe("two tasks with harness costs and one orchestrator call", () => {
    const refreshed = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { cost_usd: 1.5 });
      seedTask(workflow, { task_id: "wf_x.2", cost_usd: 0.25 });
      workflow.store.recordModelUsage({
        purpose: "orchestrator",
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0.5,
      });
    });

    it("adds the harness-reported task costs to the orchestrator's own", () =>
      refreshed((workflow) => {
        expect(workflow.store.workflowCost()).toBe(2.25);
      }));
  });
});

describe("taskCostText", () => {
  it("prints a reported cost", () => {
    expect(taskCostText(0.42)).toBe("$0.42");
  });

  it("calls zero unknown", () => {
    expect(taskCostText(0)).toBe("unknown");
  });
});
