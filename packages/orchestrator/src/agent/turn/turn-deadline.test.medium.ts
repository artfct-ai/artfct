import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { HangingDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { ScriptedFailure } from "../../../test/fake-model";
import type { Scenario } from "../../../test/scenario";
import { TurnCoalescer } from "../../workflow/task/harness/turn";
import { eventMessage } from "../transcript/envelope";
import { runAgentTurn } from "./turn";
import { turnTimeoutText } from "./watchdog";

const TURN_TIMEOUT_MINUTES = 0.0005;

const asked: InboundEvent = {
  id: "evt-asked",
  kind: "prompt",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "What is the status?",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
};

function personWrote(workflow: FakeRuntime, text: string): void {
  const message = eventMessage(
    { ...asked, text },
    { first: false, job: null, artifact: null, notes: [] },
  );
  workflow.transcript.enqueue(message, "message");
}

type Stuck = { workflow: FakeRuntime; decisions: HangingDecisions; elapsedMs: number };

function stuckDecisions(
  turns: (workflow: FakeRuntime, decisions: HangingDecisions) => Promise<void>,
): Scenario<Stuck> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      const decisions = new HangingDecisions();
      workflow.gatewayInstance = new FakeGateway({ decisions });
      workflow.modelInstance = new ScriptedFailure(["text"]);
      const { orchestrator } = workflow.config();
      workflow.patchConfig({
        orchestrator: { ...orchestrator, turn_timeout_minutes: TURN_TIMEOUT_MINUTES },
      });
      const started = Date.now();
      await turns(workflow, decisions);
      await run({ workflow, decisions, elapsedMs: Date.now() - started });
    });
}

describe("a turn whose decisions call never returns", () => {
  const stuck = stuckDecisions(async (workflow) => {
    personWrote(workflow, "What is the status?");
    await runAgentTurn(workflow);
  });

  it("ends soon after the deadline", () =>
    stuck(({ elapsedMs }) => {
      expect(elapsedMs).toBeLessThan(2000);
    }));

  it("tells the person it timed out", () =>
    stuck(({ workflow }) => {
      expect(workflow.posted).toEqual([
        { type: "info", text: turnTimeoutText(TURN_TIMEOUT_MINUTES) },
      ]);
    }));

  it("lets go of the turn", () =>
    stuck(({ workflow }) => {
      expect(workflow.state.turn_started_at).toBeNull();
    }));
});

describe("a message queued behind a turn stuck on the decisions model", () => {
  const queued = stuckDecisions(async (workflow, decisions) => {
    const turns = new TurnCoalescer();
    personWrote(workflow, "What is the status?");
    const first = turns.run(() => runAgentTurn(workflow));
    while (decisions.calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    personWrote(workflow, "Are you there?");
    await turns.run(() => runAgentTurn(workflow));
    await first;
  });

  it("runs in the next turn once the deadline ends the first", () =>
    queued(({ decisions }) => {
      expect(decisions.calls).toBe(2);
    }));

  it("leaves nothing in the inbox", () =>
    queued(({ workflow }) => {
      expect(workflow.transcript.inbox()).toEqual([]);
    }));

  it("tells the person twice that a turn timed out", () =>
    queued(({ workflow }) => {
      expect(workflow.posted).toHaveLength(2);
    }));
});
