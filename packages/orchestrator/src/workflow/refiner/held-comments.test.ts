import type { HeldComment } from "@artfct-ai/adapters/documents/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { fakeDocumentsOf, seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import {
  heldCommentCounts,
  REVISION_REQUEST_PROMPT,
  sendHeldCommentsOnRevisionRequest,
} from "./held-comments";

const JOB = "wf_x-1";
const TASK = "wf_x.1";
const PAGE_ID = "0123456789abcdef0123456789abcdef";
const PAGE_URL = `https://www.notion.so/acme/${PAGE_ID}`;
const HELD: HeldComment[] = [{ id: "cmt-1", author_name: "Ann", text: "Tighten the intro." }];
const HELD_TEXT =
  "The people who commented on the page said:\n\nComments:\n- [comment cmt-1]: Ann: Tighten the intro.";

function pageScenario(held: HeldComment[], status: "in_review" | "done"): Scenario<FakeRuntime> {
  return scenario(freshRuntime, (workflow) => {
    workflow.documentsInstance = new FakeDocuments({ held });
    workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions({}) });
    seedTask(workflow, { stage: "design", status }, { prompt_in_flight: 1 });
    workflow.store.upsertArtifact({
      job_id: JOB,
      kind: "page",
      external_url: PAGE_URL,
      ref: { kind: "page", page_id: PAGE_ID },
    });
  });
}

describe("sendHeldCommentsOnRevisionRequest", () => {
  describe("an idle author with a comment held on its page", () => {
    const idle = pageScenario(HELD, "in_review");

    it("sends the held comment to the author under the revision request", () =>
      idle(async (workflow) => {
        await sendHeldCommentsOnRevisionRequest(workflow);
        expect(workflow.store.queue().map((row) => [row.task_id, row.text])).toEqual([
          [TASK, `${REVISION_REQUEST_PROMPT}\n\n${HELD_TEXT}`],
        ]);
      }));

    it("marks the comment read on the page", () =>
      idle(async (workflow) => {
        await sendHeldCommentsOnRevisionRequest(workflow);
        expect(fakeDocumentsOf(workflow).argsOf("acknowledgeComment")).toEqual([
          [{ pageId: PAGE_ID, commentId: "cmt-1" }],
        ]);
      }));

    it("names the author it prompted and tells the agent", () =>
      idle(async (workflow) => {
        expect(await sendHeldCommentsOnRevisionRequest(workflow)).toEqual({
          prompted: [TASK],
          notes: [
            `The person asked for a revision, so the system sent the 1 comment held on ${PAGE_URL} to the author ${TASK}. The author revises the page now. Do not send them again.`,
          ],
        });
      }));

    it("sends nothing on a second request", () =>
      idle(async (workflow) => {
        await sendHeldCommentsOnRevisionRequest(workflow);
        expect(await sendHeldCommentsOnRevisionRequest(workflow)).toEqual({
          prompted: [],
          notes: [],
        });
        expect(workflow.store.queue()).toHaveLength(1);
      }));
  });

  describe("a page with no held comments", () => {
    const empty = pageScenario([], "in_review");

    it("prompts nobody and says nothing", () =>
      empty(async (workflow) => {
        expect(await sendHeldCommentsOnRevisionRequest(workflow)).toEqual({
          prompted: [],
          notes: [],
        });
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("a finished author", () => {
    const finished = pageScenario(HELD, "done");

    it("leaves the comments held", () =>
      finished(async (workflow) => {
        await sendHeldCommentsOnRevisionRequest(workflow);
        expect(fakeDocumentsOf(workflow).argsOf("heldComments")).toEqual([]);
        expect(fakeDocumentsOf(workflow).argsOf("acknowledgeComment")).toEqual([]);
      }));
  });

  describe("held comments the screen cannot check", () => {
    const unchecked = scenario(pageScenario(HELD, "in_review"), (workflow) => {
      workflow.gatewayInstance = new FakeGateway({
        decisions: new FakeDecisions(new Error("gateway timeout")),
      });
    });

    it("prompts nobody, leaves them held, and tells the agent why", () =>
      unchecked(async (workflow) => {
        expect(await sendHeldCommentsOnRevisionRequest(workflow)).toEqual({
          prompted: [],
          notes: [
            `The person asked for a revision. The comments held on ${PAGE_URL} were not sent. The screen could not check them right now. They stay held. Tell the person.`,
          ],
        });
        expect(workflow.store.queue()).toEqual([]);
        expect(fakeDocumentsOf(workflow).argsOf("acknowledgeComment")).toEqual([]);
      }));
  });
});

describe("heldCommentCounts", () => {
  it("counts the comments held on the page of a running author", () =>
    pageScenario(
      HELD,
      "in_review",
    )(async (workflow) => {
      expect(await heldCommentCounts(workflow)).toEqual(new Map([[JOB, 1]]));
    }));

  it("says null when the host cannot be read", () =>
    scenario(pageScenario(HELD, "in_review"), (workflow) => {
      workflow.documentsInstance = new FakeDocuments({ held: HELD, failing: true });
    })(async (workflow) => {
      expect(await heldCommentCounts(workflow)).toEqual(new Map([[JOB, null]]));
    }));

  it("leaves out a finished author", () =>
    pageScenario(
      HELD,
      "done",
    )(async (workflow) => {
      expect(await heldCommentCounts(workflow)).toEqual(new Map());
    }));
});
