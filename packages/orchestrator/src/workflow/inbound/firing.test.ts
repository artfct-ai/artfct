import { beforeEach, describe, expect, it } from "bun:test";
import { FakeRuntime, openFakeConversation, seedEndedWorkflow } from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { sqliteD1 } from "../../../test/sqlite-d1";
import { testEnv } from "../../../test/test-env";
import { TEST_DEFINITION_NAME } from "../../../test/test-config";
import { createDb } from "../../db/client";
import { findWorkflow } from "../../db/workflows";
import { firingKey } from "../../triggers/firing-key";
import type { ConversationFiring, FiringAnswer } from "../../triggers/types";
import { fireWorkflow } from "./firing";

const CONVERSATION_ID = "cv_firing";

const FIRING: ConversationFiring = {
  firing: {
    cause: { kind: "schedule", minute: "2026-10-19T09:00:00.000Z" },
    definition: TEST_DEFINITION_NAME,
    position: 0,
    attempt: 1,
  },
  trigger: { schedule: "0 9 * * 1-5", channel: "C1", prompt: "Upgrade the dependencies." },
  thread: "1.0",
};

const NEXT_DAY: ConversationFiring = {
  ...FIRING,
  firing: { ...FIRING.firing, cause: { kind: "schedule", minute: "2026-10-20T09:00:00.000Z" } },
};

function freshConversation(): FakeRuntime {
  return new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: sqliteD1() }, "uncreated");
}

function fire(workflow: FakeRuntime, firing: ConversationFiring = FIRING): Promise<FiringAnswer> {
  return fireWorkflow(workflow, { conversationId: CONVERSATION_ID, firing });
}

describe("fireWorkflow", () => {
  describe("a firing that opens its conversation", () => {
    let workflow: FakeRuntime;
    let answer: FiringAnswer;

    beforeEach(async () => {
      workflow = freshConversation();
      answer = await fire(workflow);
    });

    it("starts a workflow", () => {
      expect(answer).toEqual({
        kind: "started",
        workflow_id: workflow.store.requireWorkflowRow().workflow_id,
      });
    });

    it("opens the conversation on the start line's thread", () => {
      expect(workflow.store.requireConversation()).toMatchObject({
        conversation_id: CONVERSATION_ID,
        origin: { source: "chat", channel: "C1", thread: "1.0" },
      });
    });

    it("runs the trigger's definition from the creation", () => {
      expect(workflow.store.requireWorkflowRow()).toMatchObject({
        status: "running",
        definition: TEST_DEFINITION_NAME,
        name: "Development",
        reason: "Fired by the schedule 0 9 * * 1-5 of workflow definition development",
      });
    });

    it("tells the agent the trigger's prompt in its first message", () => {
      expect(workflow.notes).toHaveLength(1);
      expect(workflow.notes[0]?.text).toContain("Upgrade the dependencies.");
      expect(workflow.notes[0]?.wake).toBe("message");
    });

    it("writes the router's row of the workflow", async () => {
      const { workflow_id } = workflow.store.requireWorkflowRow();
      expect(await findWorkflow(createDb(workflow.env.DB), workflow_id)).toMatchObject({
        conversation_id: CONVERSATION_ID,
        status: "running",
      });
    });

    it("records the firing key as seen", () => {
      expect(workflow.store.eventSeen(firingKey(FIRING.firing))).toBe(true);
    });
  });

  describe("a firing delivered again", () => {
    it("gets the duplicate answer and leaves the one workflow", async () => {
      const workflow = freshConversation();
      await fire(workflow);
      const started = workflow.store.requireWorkflowRow();
      expect(await fire(workflow, { ...FIRING, firing: { ...FIRING.firing, attempt: 2 } })).toEqual(
        { kind: "duplicate" },
      );
      expect(workflow.store.requireWorkflowRow()).toEqual(started);
      expect(workflow.notes).toHaveLength(1);
    });
  });

  describe("a firing on a conversation with an active workflow", () => {
    let workflow: FakeRuntime;
    let answer: FiringAnswer;

    beforeEach(async () => {
      workflow = freshConversation();
      await fire(workflow);
      workflow.store.updateWorkflow({ status: "ending" });
      answer = await fire(workflow, NEXT_DAY);
    });

    it("refuses it, naming the active workflow", () => {
      expect(answer).toEqual({
        kind: "active_workflow",
        workflow_id: workflow.store.requireWorkflowRow().workflow_id,
      });
    });

    it("does not record the firing as seen, so its next attempt can start", () => {
      expect(workflow.notes).toHaveLength(1);
      expect(workflow.store.eventSeen(firingKey(NEXT_DAY.firing))).toBe(false);
    });
  });

  describe("a firing after the active workflow ended", () => {
    it("starts the next workflow in the same conversation", async () => {
      const workflow = freshConversation();
      await fire(workflow);
      const first = workflow.store.requireWorkflowRow().workflow_id;
      seedEndedWorkflow(workflow, "done");
      const answer = await fire(workflow, NEXT_DAY);
      expect(answer.kind).toBe("started");
      expect(workflow.store.requireWorkflowRow().workflow_id).not.toBe(first);
    });
  });

  describe("a firing on a conversation a person opened first", () => {
    it("keeps the conversation and starts the workflow", async () => {
      const workflow = freshConversation();
      openFakeConversation(workflow);
      const opened = workflow.store.requireConversation();
      expect((await fire(workflow)).kind).toBe("started");
      expect(workflow.store.requireConversation()).toEqual(opened);
    });
  });
});
