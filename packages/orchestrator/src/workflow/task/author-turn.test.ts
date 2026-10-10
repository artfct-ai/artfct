import { describe, expect, it } from "bun:test";
import type { Choice } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions, HangingDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { seedPullRequestTask, seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import type { TodoSnapshot } from "../board/types";
import { AUTHOR_TURN_PURPOSE, authorTurnOutcome } from "./author-turn";
import { AUTHOR_WORK } from "./gave-up";

const TASK = "wf_x.1";
const CLOSING = "The test suite runs in the background. I will report the result when it finishes.";

const OPEN_TODOS: TodoSnapshot = {
  entries: [
    { content: "Change the redirect", priority: "medium", status: "completed" },
    { content: "Run the tests", priority: "medium", status: "in_progress" },
  ],
};

const DONE_TODOS: TodoSnapshot = {
  entries: [{ content: "Change the redirect", priority: "medium", status: "completed" }],
};

function decisionsPick(workflow: FakeRuntime, outcome: Choice | Error): FakeDecisions {
  const decisions =
    outcome instanceof Error ? new FakeDecisions(outcome) : new FakeDecisions({}, { outcome });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

describe("authorTurnOutcome", () => {
  for (const option of ["finished", "waits_on_person", "blocked", "stopped_early"] as const) {
    it(`is ${option} when the decisions model picks it`, () =>
      freshRuntime(async (workflow) => {
        decisionsPick(workflow, { option, probability: 0.6 });
        const author = seedTask(workflow, { summary: CLOSING });
        expect(await authorTurnOutcome(workflow, author)).toBe(option);
      }));
  }

  it("shows the decisions model the work of the author's stage and the closing text", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsPick(workflow, { option: "finished", probability: 1 });
      const author = seedTask(workflow, { summary: CLOSING });
      await authorTurnOutcome(workflow, author);
      expect(decisions.asked).toEqual([
        { work: AUTHOR_WORK[workflow.stageForTask(author).artifact], turn_text: CLOSING },
      ]);
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, { option: "finished", probability: 1 });
      await authorTurnOutcome(workflow, seedTask(workflow, { summary: CLOSING }));
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([AUTHOR_TURN_PURPOSE]);
    }));

  it("does not ask about a turn that closed without text", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsPick(workflow, { option: "blocked", probability: 1 });
      expect(await authorTurnOutcome(workflow, seedTask(workflow, { summary: " " }))).toBe(
        "finished",
      );
      expect(decisions.asked).toEqual([]);
    }));

  describe("without an answer", () => {
    it("is stopped early with open todos and no artifact", () =>
      freshRuntime(async (workflow) => {
        decisionsPick(workflow, new Error("unavailable"));
        const author = seedTask(workflow, { summary: CLOSING });
        workflow.store.setTodos(TASK, OPEN_TODOS);
        expect(await authorTurnOutcome(workflow, author)).toBe("stopped_early");
      }));

    it("is finished with open todos and an artifact", () =>
      freshRuntime(async (workflow) => {
        decisionsPick(workflow, new Error("unavailable"));
        const author = seedPullRequestTask(workflow, { summary: CLOSING });
        workflow.store.setTodos(TASK, OPEN_TODOS);
        expect(await authorTurnOutcome(workflow, author)).toBe("finished");
      }));

    it("is finished when every todo is done", () =>
      freshRuntime(async (workflow) => {
        decisionsPick(workflow, new Error("unavailable"));
        const author = seedTask(workflow, { summary: CLOSING });
        workflow.store.setTodos(TASK, DONE_TODOS);
        expect(await authorTurnOutcome(workflow, author)).toBe("finished");
      }));

    it("is finished without a todo list", () =>
      freshRuntime(async (workflow) => {
        decisionsPick(workflow, new Error("unavailable"));
        expect(await authorTurnOutcome(workflow, seedTask(workflow, { summary: CLOSING }))).toBe(
          "finished",
        );
      }));

    it("is stopped early with open todos when the model hangs past its deadline", () =>
      freshRuntime(async (workflow) => {
        const decisions = new HangingDecisions(5);
        workflow.gatewayInstance = new FakeGateway({ decisions });
        const author = seedTask(workflow, { summary: CLOSING });
        workflow.store.setTodos(TASK, OPEN_TODOS);
        expect(await authorTurnOutcome(workflow, author)).toBe("stopped_early");
        expect(decisions.calls).toBe(1);
      }));

    it("takes a pick the question does not offer as no answer", () =>
      freshRuntime(async (workflow) => {
        decisionsPick(workflow, { option: "none", probability: 1 });
        const author = seedTask(workflow, { summary: CLOSING });
        workflow.store.setTodos(TASK, OPEN_TODOS);
        expect(await authorTurnOutcome(workflow, author)).toBe("stopped_early");
      }));
  });
});
