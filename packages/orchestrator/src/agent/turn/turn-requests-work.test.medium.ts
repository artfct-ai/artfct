import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { EchoModel } from "../../../test/fake-model";
import type { Scenario } from "../../../test/scenario";
import { eventMessage } from "../transcript/envelope";
import { PLAN_RULES } from "../tools/plan";
import { runAgentTurn } from "./turn";

const wrote: InboundEvent = {
  id: "evt-wrote",
  kind: "start",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "how does the refiner work?",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
};

function personTurn(answers: Record<string, number>): Scenario<EchoModel> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      const model = new EchoModel("The refiner reviews each artifact.");
      workflow.modelInstance = model;
      workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions(answers) });
      const message = eventMessage(wrote, { first: true, job: null, artifact: null, notes: [] });
      workflow.transcript.enqueue(message, "message");
      await runAgentTurn(workflow);
      await run(model);
    });
}

describe("a person's turn", () => {
  describe("a message the decisions model reads as a question", () => {
    const asked = personTurn({ wants_answer: 0.9, wants_work: 0.1 });

    it("leaves the plan rules out of the system prompt", () =>
      asked((model) => {
        expect(model.systems[0]).not.toContain(PLAN_RULES);
      }));
  });

  describe("a message the decisions model reads as a request for work", () => {
    const asked = personTurn({ wants_answer: 0.1, wants_work: 0.9 });

    it("carries the plan rules in the system prompt", () =>
      asked((model) => {
        expect(model.systems[0]).toContain(PLAN_RULES);
      }));
  });
});
