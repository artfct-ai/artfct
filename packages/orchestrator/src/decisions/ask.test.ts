import { describe, expect, it } from "bun:test";
import { FakeDecisions, HangingDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import type { FakeRuntime } from "../../test/fake-runtime";
import { freshRuntime } from "../../test/fresh-runtime";
import { askYesNo, type TurnDecisions } from "./ask";

const QUESTIONS = { clean: { instructions: "Is `text` clean?", yes: "It is.", no: "It is not." } };
const ANSWERS = { clean: 0.9 };

function turnDecisions(): TurnDecisions {
  return { signal: new AbortController().signal, failed: false };
}

function askClean(workflow: FakeRuntime, turn: TurnDecisions) {
  return askYesNo(workflow, { purpose: "test", state: { text: "hi" }, questions: QUESTIONS, turn });
}

function withDecisions(
  decisions: Decisions,
  run: (workflow: FakeRuntime) => Promise<void>,
): Promise<void> {
  return freshRuntime(async (workflow) => {
    workflow.gatewayInstance = new FakeGateway({ decisions });
    await run(workflow);
  });
}

describe("askYesNo in an agent turn", () => {
  describe("after a call of the turn failed", () => {
    it("answers null without asking the decisions model", async () => {
      const decisions = new FakeDecisions(new Error("every model failed"));
      await withDecisions(decisions, async (workflow) => {
        const turn = turnDecisions();
        await askClean(workflow, turn);
        expect(await askClean(workflow, turn)).toBeNull();
        expect(decisions.asked).toHaveLength(1);
      });
    });

    it("asks the decisions model again in the next turn", async () => {
      let failing = true;
      const decisions = new FakeDecisions(() =>
        failing ? new Error("every model failed") : ANSWERS,
      );
      await withDecisions(decisions, async (workflow) => {
        await askClean(workflow, turnDecisions());
        failing = false;
        expect(await askClean(workflow, turnDecisions())).toEqual(ANSWERS);
      });
    });
  });

  describe("after a call of the turn ran past its deadline", () => {
    it("answers null without asking the decisions model", async () => {
      const decisions = new HangingDecisions(5);
      await withDecisions(decisions, async (workflow) => {
        const turn = turnDecisions();
        await askClean(workflow, turn);
        expect(await askClean(workflow, turn)).toBeNull();
        expect(decisions.calls).toBe(1);
      });
    });
  });

  describe("after a call of the turn answered", () => {
    it("asks the decisions model again", async () => {
      const decisions = new FakeDecisions(ANSWERS);
      await withDecisions(decisions, async (workflow) => {
        const turn = turnDecisions();
        await askClean(workflow, turn);
        expect(await askClean(workflow, turn)).toEqual(ANSWERS);
        expect(decisions.asked).toHaveLength(2);
      });
    });
  });
});
