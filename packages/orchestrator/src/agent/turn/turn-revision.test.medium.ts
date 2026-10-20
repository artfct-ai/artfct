import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { EchoModel } from "../../../test/fake-model";
import type { Scenario } from "../../../test/scenario";
import { REVISION_REQUEST_PROMPT } from "../../workflow/refiner/held-comments";
import { REVISION_ACKNOWLEDGEMENT_TEXT } from "../tools/channel";
import { eventMessage } from "../transcript/envelope";
import { runAgentTurn } from "./turn";

const PAGE_ID = "0123456789abcdef0123456789abcdef";
const PAGE_URL = `https://www.notion.so/acme/${PAGE_ID}`;

const wrote: InboundEvent = {
  id: "evt-reviewed",
  kind: "prompt",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "@artfct left a review",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
};

type Turned = { workflow: FakeRuntime; model: EchoModel };

function personTurn(answers: Record<string, number>): Scenario<Turned> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      const model = new EchoModel("The author revises the page now.");
      workflow.modelInstance = model;
      workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions(answers) });
      workflow.documentsInstance = new FakeDocuments({
        held: [{ id: "cmt-1", author_name: "Ann", text: "Name the owner of the table." }],
      });
      seedTask(workflow, { stage: "design", status: "in_review" });
      workflow.store.upsertArtifact({
        job_id: "wf_x-1",
        kind: "page",
        external_url: PAGE_URL,
        ref: { kind: "page", page_id: PAGE_ID },
      });
      const message = eventMessage(wrote, { first: false, job: null, artifact: null, notes: [] });
      workflow.transcript.enqueue(message, "message", { body: wrote.text });
      await runAgentTurn(workflow);
      await run({ workflow, model });
    });
}

function queuedTexts(workflow: FakeRuntime): string[] {
  return workflow.store.queue().map((row) => row.text);
}

describe("a person's turn", () => {
  describe("a message that says the person left a review", () => {
    const reviewed = personTurn({ wants_answer: 0.2, wants_work: 0.1, asks_revision: 0.9 });

    it("sends the held comments to the author before the model runs", () =>
      reviewed(({ workflow }) => {
        expect(queuedTexts(workflow)).toEqual([
          `${REVISION_REQUEST_PROMPT}\n\nThe people who commented on the page said:\n\nComments:\n- [comment cmt-1]: Ann: Name the owner of the table.`,
        ]);
      }));

    it("answers the person first", () =>
      reviewed(({ workflow }) => {
        expect(workflow.posted[0]).toEqual({ type: "info", text: REVISION_ACKNOWLEDGEMENT_TEXT });
      }));

    it("tells the model what the system sent", () =>
      reviewed(({ model }) => {
        expect(model.userTexts.join("\n")).toContain(
          `the system sent 1 comment held on ${PAGE_URL} to the author wf_x.1`,
        );
      }));
  });

  describe("a message that does not ask for a revision", () => {
    const asked = personTurn({ wants_answer: 0.9, wants_work: 0.1, asks_revision: 0.1 });

    it("leaves the comments held", () =>
      asked(({ workflow }) => {
        expect(queuedTexts(workflow)).toEqual([]);
      }));

    it("shows the model the count of held comments", () =>
      asked(({ model }) => {
        expect(model.systems[0]).toContain(" held_comments=1");
      }));
  });
});
