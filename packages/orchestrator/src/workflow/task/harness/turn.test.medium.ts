import type { SessionNotification } from "@agentclientprotocol/sdk";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../../test/durable-runtime";
import { onSessionUpdate, onTurnEnd } from "./turn";
import { seedTask, type FakeRuntime } from "../../../../test/fake-runtime";
import { scenario } from "../../../../test/scenario";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const DOC = "https://linear.app/acme/document/design-1";

function chunk(text: string): SessionNotification {
  return {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  };
}

function knowsTheDocument(workflow: FakeRuntime): void {
  workflow.documentsInstance = new FakeDocuments({ pages: { [DOC]: "content1" } });
}

describe("onSessionUpdate", () => {
  describe("streamed agent text that names a document halfway through", () => {
    const started = scenario(freshDurableRuntime, (workflow) => {
      knowsTheDocument(workflow);
      return onSessionUpdate(workflow, seedTask(workflow), chunk("Design at "));
    });

    it("records no artifact from the half of the link it has", () =>
      started((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
      }));

    describe("and the rest of the text, which completes the link", () => {
      const finished = scenario(started, (workflow) =>
        onSessionUpdate(workflow, workflow.store.requireTask(TASK), chunk(`${DOC} done`)),
      );

      it("joins the streamed text", () =>
        finished((workflow) => {
          expect(workflow.store.requireSandbox(TASK).turn_text).toBe(`Design at ${DOC} done`);
        }));

      it("records the document as the task's artifact", () =>
        finished((workflow) => {
          expect(workflow.store.artifact(JOB)).toMatchObject({
            kind: "page",
            external_url: DOC,
          });
        }));

      it("puts the task in review", () =>
        finished((workflow) => {
          expect(workflow.store.requireTask(TASK).status).toBe("in_review");
        }));

      it("says nothing to the humans, because the review holds the page", () =>
        finished((workflow) => {
          expect(workflow.posted.map((event) => event.type)).toEqual([]);
        }));
    });
  });

  describe("a cancelled task whose harness was still sending when the container went", () => {
    const late = scenario(freshDurableRuntime, (workflow) => {
      knowsTheDocument(workflow);
      const task = seedTask(workflow, { status: "cancelled" });
      return onSessionUpdate(workflow, task, chunk(`Design at ${DOC} done`));
    });

    it("records no artifact from the frame", () =>
      late((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
      }));

    it("leaves the task cancelled instead of putting it back in review", () =>
      late((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("cancelled");
      }));
  });
});

describe("onTurnEnd", () => {
  describe("a turn whose text named an artifact", () => {
    const ended = scenario(freshDurableRuntime, (workflow) => {
      knowsTheDocument(workflow);
      return onTurnEnd(
        workflow,
        seedTask(workflow, {}, { turn_text: `Published ${DOC}` }),
        "end_turn",
      );
    });

    it("tells the humans nothing, because the review holds the page", () =>
      ended((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("records the artifact", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(JOB)?.external_url).toBe(DOC);
      }));

    it("leaves the agent alone while the review holds the page", () =>
      ended((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));

    it("keeps the page a draft until the review settles", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("a cancelled task whose turn end landed after the cancel", () => {
    const late = scenario(freshDurableRuntime, (workflow) => {
      knowsTheDocument(workflow);
      const task = seedTask(workflow, { status: "cancelled" }, { turn_text: `Published ${DOC}` });
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("records no artifact from the turn text", () =>
      late((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
      }));

    it("leaves the task cancelled instead of putting it back in review", () =>
      late((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("cancelled");
      }));
  });
});
