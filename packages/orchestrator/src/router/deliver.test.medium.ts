import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding, ConversationPlace } from "@artfct-ai/contracts/sources";
import type { Delivery, WorkflowStatus } from "@artfct-ai/contracts/types";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimBinding, listBindings } from "../db/bindings";
import { createDb } from "../db/client";
import { conversationIdOf, conversationRecorded } from "../db/conversations";
import { workflows } from "../db/schema";
import { writeWorkflowRow } from "../db/workflows";
import { deliver } from "./deliver";

const db = createDb(env.DB);

const NOTHING_TO_JOIN_ERROR = {
  type: "error",
  body: "No workflow is working on this issue. Delegate it to me or mention me to start one.",
};
const STARTING_THOUGHT = { type: "thought", body: "On it. Reading the issue." };

const prClosed: InboundEvent = {
  id: "evt-pr-closed",
  kind: "pr_event",
  actor: null,
  bindings: [],
  links: [],
  text: "PR closed",
  pull: { repo: "acme/app", number: 7, action: "closed", branch: "artfct/cv_x-1-fix" },
};

const slackThread: ConversationPlace = { source: "chat_thread", channel: "C1", thread: "1.0" };

const slackStart: InboundEvent = {
  id: "evt-slack-start",
  kind: "start",
  actor: { email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "fix the flaky test",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
  place: slackThread,
};

const slackPrompt: InboundEvent = {
  ...slackStart,
  id: "evt-slack-prompt",
  kind: "prompt",
  text: "also add a test",
};

const issuePlace: ConversationPlace = { source: "tracker_issue", issue_id: "ISS-7" };
const issueBinding: Binding = { source: "tracker_issue", external_id: "ISS-7" };

const linearStart: InboundEvent = {
  ...slackStart,
  id: "evt-linear-start",
  bindings: [issueBinding],
  reply_to: { source: "tracker", session_id: "sess-7", issue_id: "ISS-7", team_id: "team-1" },
  place: issuePlace,
};

async function seedWorkflow(
  workflowId: string,
  conversationId: string,
  status: WorkflowStatus = "running",
): Promise<void> {
  await writeWorkflowRow(db, { workflow_id: workflowId, conversation_id: conversationId, status });
  await runInDurableObject(env.Conversation.getByName(conversationId), async (conversation) => {
    await conversation.status(workflowId);
    if (conversation.store.conversation()) return;
    conversation.store.openConversation({
      conversation_id: conversationId,
      request_title: "",
      request_text: "",
      request_links: [],
      origin: null,
    });
  });
}

async function seedBinding(binding: Binding, workflowId: string): Promise<void> {
  await claimBinding(db, binding, { previous: null, workflowId });
}

async function stopTurnAndReadLog(conversationId: string): Promise<string[]> {
  const stub = env.Conversation.getByName(conversationId);
  return runInDurableObject(stub, async (conversation) => {
    const dump = (await conversation.debug()) as { log: Array<{ line: string }> };
    await conversation.cancelAllAlarms();
    return dump.log.map((entry) => entry.line);
  });
}

function activities(tracker: FakeTracker): unknown[][] {
  return tracker.argsOf("activity").map(([sessionId, content]) => [sessionId, content]);
}

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

async function workflowRows(): Promise<unknown[]> {
  return db.select().from(workflows);
}

describe("an event without a binding or a place", () => {
  it("drops it, since no conversation waits for it", async () => {
    expect(await deliver(env, prClosed)).toEqual({ dropped: "no conversation for pr_event" });
  });
});

describe("an event bound to a running workflow", () => {
  const branch = { source: "code_branch", repo: "acme/app", branch: "artfct/cv_x-1-fix" } as const;
  let delivery: Delivery;

  beforeEach(async () => {
    await seedWorkflow("wf_run", "cv_run");
    await seedBinding(branch, "wf_run");
    delivery = await deliver(env, { ...prClosed, id: "evt-pr-run", bindings: [branch] });
  });

  it("reaches the conversation of that workflow", () => {
    expect(delivery).toEqual({ conversation_id: "cv_run", result: { ok: true } });
  });

  it("hands the event to it", async () => {
    expect(await stopTurnAndReadLog("cv_run")).toContain("event pr_event");
  });
});

describe("an event bound to a workflow that ended before its end removed the binding", () => {
  const branch = { source: "code_branch", repo: "acme/app", branch: "artfct/cv_x-1-fix" } as const;
  let delivery: Delivery;

  beforeEach(async () => {
    await seedWorkflow("wf_gone", "cv_gone", "done");
    await seedBinding(branch, "wf_gone");
    delivery = await deliver(env, { ...prClosed, id: "evt-pr-gone", bindings: [branch] });
  });

  it("drops it", () => {
    expect(delivery).toEqual({ dropped: "no conversation for pr_event" });
  });

  it("never reaches the conversation", async () => {
    expect(await stopTurnAndReadLog("cv_gone")).not.toContain("event pr_event");
  });
});

describe("a Slack start in a thread", () => {
  let delivery: Delivery;
  let conversationId: string;

  beforeEach(async () => {
    conversationId = await conversationIdOf(slackThread);
    delivery = await deliver(env, slackStart);
    await stopTurnAndReadLog(conversationId);
  });

  it("reaches the conversation the thread names", () => {
    expect(delivery).toEqual({ conversation_id: conversationId, result: { ok: true } });
  });

  it("records the conversation", async () => {
    expect(await conversationRecorded(db, slackThread)).toBe(true);
  });

  it("opens the conversation from the start", async () => {
    expect(await stopTurnAndReadLog(conversationId)).toContain("opened from start");
  });

  it("creates no workflow, since only a plan creates one", async () => {
    expect(await workflowRows()).toEqual([]);
  });

  it("binds nothing", async () => {
    expect(await listBindings(db)).toEqual([]);
  });

  describe("and then a prompt in the thread", () => {
    beforeEach(async () => {
      delivery = await deliver(env, slackPrompt);
    });

    it("reaches the same conversation", () => {
      expect(delivery).toEqual({ conversation_id: conversationId, result: { ok: true } });
    });

    it("hands the prompt to it", async () => {
      expect(await stopTurnAndReadLog(conversationId)).toContain("event prompt");
    });

    it("still creates no workflow", async () => {
      expect(await workflowRows()).toEqual([]);
    });
  });

  describe("and then a prompt after the conversation's workflow ended", () => {
    beforeEach(async () => {
      await writeWorkflowRow(db, {
        workflow_id: "wf_ended",
        conversation_id: conversationId,
        status: "done",
      });
      delivery = await deliver(env, { ...slackPrompt, id: "evt-slack-after-end" });
    });

    it("reaches the same conversation, where the next workflow starts", () => {
      expect(delivery).toEqual({ conversation_id: conversationId, result: { ok: true } });
    });

    it("hands the prompt to its agent", async () => {
      expect(await stopTurnAndReadLog(conversationId)).toContain("event prompt");
    });
  });
});

describe("a Slack prompt in a thread where nothing started", () => {
  let delivery: Delivery;
  let objectsBefore: number;

  beforeEach(async () => {
    objectsBefore = (await listDurableObjectIds(env.Conversation)).length;
    delivery = await deliver(env, { ...slackPrompt, id: "evt-slack-orphan" });
  });

  it("drops it", () => {
    expect(delivery).toEqual({ dropped: "no conversation in its chat_thread" });
  });

  it("opens no conversation", async () => {
    expect(await listDurableObjectIds(env.Conversation)).toHaveLength(objectsBefore);
  });
});

describe("a stop in a session whose issue has no conversation", () => {
  let tracker: FakeTracker;
  let delivery: Delivery;

  beforeEach(async () => {
    tracker = new FakeTracker();
    delivery = await deliver(env, { ...linearStart, id: "evt-linear-stop", kind: "stop" }, tracker);
  });

  it("drops it", () => {
    expect(delivery).toEqual({ dropped: "no conversation in its tracker_issue" });
  });

  it("posts nothing on the session", () => {
    expect(tracker.calls).toEqual([]);
  });
});

describe("a person's message in a session whose issue has no conversation", () => {
  let tracker: FakeTracker;
  let delivery: Delivery;
  let objectsBefore: number;

  beforeEach(async () => {
    objectsBefore = (await listDurableObjectIds(env.Conversation)).length;
    tracker = new FakeTracker();
    delivery = await deliver(
      env,
      { ...linearStart, id: "evt-linear-orphan", kind: "prompt", text: "also add docs" },
      tracker,
    );
  });

  it("drops it", () => {
    expect(delivery).toEqual({ dropped: "no conversation in its tracker_issue" });
  });

  it("tells the person that no workflow is working on the issue", () => {
    expect(activities(tracker)).toEqual([["sess-7", NOTHING_TO_JOIN_ERROR]]);
  });

  it("opens no conversation", async () => {
    expect(await listDurableObjectIds(env.Conversation)).toHaveLength(objectsBefore);
  });
});

describe("a Linear session start", () => {
  let tracker: FakeTracker;
  let delivery: Delivery;
  let issueConversation: string;

  beforeEach(async () => {
    tracker = new FakeTracker();
    issueConversation = await conversationIdOf(issuePlace);
  });

  describe("by a person, on an issue without a conversation", () => {
    beforeEach(async () => {
      delivery = await deliver(env, linearStart, tracker);
      await stopTurnAndReadLog(issueConversation);
    });

    it("reaches the conversation of the issue", () => {
      expect(delivery).toEqual({ conversation_id: issueConversation, result: { ok: true } });
    });

    it("tells the session it is on it", () => {
      expect(activities(tracker)).toEqual([["sess-7", STARTING_THOUGHT]]);
    });

    it("posts it as an ephemeral thought that the next activity replaces", () => {
      expect(tracker.argsOf("activity")[0]?.[2]).toEqual({ ephemeral: true });
    });

    it("creates no workflow", async () => {
      expect(await workflowRows()).toEqual([]);
    });

    describe("and then a person's message in another session of the issue", () => {
      beforeEach(async () => {
        delivery = await deliver(
          env,
          {
            ...linearStart,
            id: "evt-linear-second-session",
            kind: "prompt",
            reply_to: { source: "tracker", session_id: "sess-8", issue_id: "ISS-7" },
          },
          tracker,
        );
      });

      it("reaches the same conversation", () => {
        expect(delivery).toEqual({ conversation_id: issueConversation, result: { ok: true } });
      });
    });
  });

  describe("that nobody opened, on an issue without a conversation", () => {
    beforeEach(async () => {
      delivery = await deliver(
        env,
        { ...linearStart, id: "evt-linear-bare", actor: null },
        tracker,
      );
      await stopTurnAndReadLog(issueConversation);
    });

    it("reaches the conversation of the issue, whose agent takes an unprompted turn", () => {
      expect(delivery).toEqual({ conversation_id: issueConversation, result: { ok: true } });
    });

    it("posts only the starting thought on the session", () => {
      expect(activities(tracker)).toEqual([["sess-7", STARTING_THOUGHT]]);
    });
  });

  describe("on an issue a running workflow of a Slack conversation bound", () => {
    beforeEach(async () => {
      await seedWorkflow("wf_slack", "cv_slack");
      await seedBinding(issueBinding, "wf_slack");
      delivery = await deliver(env, { ...linearStart, id: "evt-linear-join" }, tracker);
      await stopTurnAndReadLog("cv_slack");
    });

    it("reaches the bound conversation", () => {
      expect(delivery).toEqual({ conversation_id: "cv_slack", result: { ok: true } });
    });

    it("posts only the starting thought on the session", () => {
      expect(activities(tracker)).toEqual([["sess-7", STARTING_THOUGHT]]);
    });
  });

  describe("in a session without an issue", () => {
    const sessionPlace: ConversationPlace = { source: "tracker_session", session_id: "sess-9" };

    beforeEach(async () => {
      delivery = await deliver(
        env,
        {
          ...linearStart,
          id: "evt-linear-loose",
          bindings: [],
          reply_to: { source: "tracker", session_id: "sess-9", issue_id: "" },
          place: sessionPlace,
        },
        tracker,
      );
    });

    it("reaches the conversation of the session alone", async () => {
      const conversationId = await conversationIdOf(sessionPlace);
      await stopTurnAndReadLog(conversationId);
      expect(delivery).toEqual({ conversation_id: conversationId, result: { ok: true } });
    });
  });

  describe("when the acknowledgement fails", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      warn = spyOnWarn();
      delivery = await deliver(
        env,
        { ...linearStart, id: "evt-linear-down" },
        new FakeTracker({ failing: true }),
      );
      await stopTurnAndReadLog(issueConversation);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("delivers anyway", () => {
      expect(delivery).toEqual({ conversation_id: issueConversation, result: { ok: true } });
    });

    it("warns which session it could not reach", () => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/tracker ack on session sess-7 failed/),
      );
    });
  });

  describe("without a Linear client", () => {
    beforeEach(async () => {
      delivery = await deliver(env, { ...linearStart, id: "evt-linear-quiet" }, null);
      await stopTurnAndReadLog(issueConversation);
    });

    it("delivers and stays silent", () => {
      expect(delivery).toEqual({ conversation_id: issueConversation, result: { ok: true } });
    });
  });
});

function baseMoved(id: string, repo: string): InboundEvent {
  return { ...prClosed, id, pull: { repo, action: "base_moved", base: "main" } };
}

describe("a base branch move", () => {
  describe("in a repository where two running workflows hold pull requests", () => {
    let delivery: Delivery;

    beforeEach(async () => {
      await seedWorkflow("wf_fan_a", "cv_fan_a");
      await seedWorkflow("wf_fan_b", "cv_fan_b");
      await seedWorkflow("wf_fan_d", "cv_fan_d");
      await seedBinding({ source: "code_pull", repo: "acme/app", number: 1 }, "wf_fan_a");
      await seedBinding({ source: "code_pull", repo: "acme/app", number: 2 }, "wf_fan_b");
      await seedBinding({ source: "code_pull", repo: "acme/app", number: 3 }, "wf_fan_b");
      await seedBinding({ source: "code_pull", repo: "acme/other", number: 4 }, "wf_fan_d");
      delivery = await deliver(env, baseMoved("evt-base", "acme/app"));
    });

    it("fans the event out to each conversation once", () => {
      expect(delivery).toEqual({ fanned_out: 2, results: [{ ok: true }, { ok: true }] });
    });

    it("hands it to the first conversation", async () => {
      expect(await stopTurnAndReadLog("cv_fan_a")).toContain("event pr_event");
    });

    it("hands it to the second conversation", async () => {
      expect(await stopTurnAndReadLog("cv_fan_b")).toContain("event pr_event");
    });

    it("leaves the conversation in another repository alone", async () => {
      expect(await stopTurnAndReadLog("cv_fan_d")).not.toContain("event pr_event");
    });
  });

  describe("in a repository whose first conversation fails to take the event", () => {
    const fannedOut = ["cv_fan_fail_a", "cv_fan_fail_b"];
    let delivery: Delivery;
    let failed: string | undefined;
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      failed = undefined;
      for (const [index, conversationId] of fannedOut.entries()) {
        const workflowId = `wf_fan_fail_${index}`;
        await seedWorkflow(workflowId, conversationId);
        await seedBinding(
          { source: "code_pull", repo: "acme/fail", number: index + 1 },
          workflowId,
        );
      }
      warn = spyOnWarn();
      const getByName = env.Conversation.getByName.bind(env.Conversation);
      const spy = vi.spyOn(env.Conversation, "getByName").mockImplementation((name) => {
        if (failed !== undefined) return getByName(name);
        failed = name;
        return new Proxy(getByName(name), {
          get: (stub, key) =>
            key === "handle"
              ? async () => {
                  throw new Error("Durable Object reset");
                }
              : Reflect.get(stub, key),
        });
      });
      delivery = await deliver(env, baseMoved("evt-base-fail", "acme/fail"));
      spy.mockRestore();
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("still counts both conversations and answers for the one that took it", () => {
      expect(delivery).toEqual({ fanned_out: 2, results: [{ ok: true }] });
    });

    it("logs the failed conversation", () => {
      expect(warn).toHaveBeenCalledWith(
        `base move delivery to ${failed} failed: Error: Durable Object reset`,
      );
    });

    it("hands it to the conversation after the one that failed", async () => {
      const after = fannedOut.find((conversationId) => conversationId !== failed) ?? "";
      expect(await stopTurnAndReadLog(after)).toContain("event pr_event");
    });
  });
});
