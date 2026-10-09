import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ActivityOptions, AgentActivityContent } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "bun:test";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { testNotifier } from "../../../test/notifier-fixture";
import { SessionTracker } from "../../../test/session-tracker";
import { FEED_POST_ATTEMPTS, type OutboxEntry } from "../../notify/notifier";
import type { TaskRow } from "../store/tasks";
import {
  DONE_TEXT,
  STOPPED_CLOSING,
  STOPPED_TEXT,
  closeAbandonedTurnFeed,
  closeSessionFeed,
  feedClosingOf,
  publishSessionPlan,
  sessionPlanOf,
  streamToSessionFeed,
} from "./feed";

const STARTING: ReplyTarget = { source: "tracker", session_id: "s-start", issue_id: "ENG-1" };
const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };

const say = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const think = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const edit = (id: string, title: string): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  kind: "edit",
});
const ended = (id: string, status: "completed" | "failed"): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status,
});

class FailingFirstTracker extends SessionTracker {
  private attempts = 0;

  override async activity(
    sessionId: string,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("tracker unavailable");
    await super.activity(sessionId, content, options);
  }
}

type Fixture = {
  workflow: FakeRuntime;
  tracker: SessionTracker;
  outbox: OutboxEntry[];
  author: TaskRow;
};

const linearOnly = (
  run: (fixture: Fixture) => Promise<void>,
  tracker: SessionTracker = new SessionTracker(),
) =>
  freshRuntime(async (workflow) => {
    workflow.patchState({ origin: STARTING, reply_targets: [STARTING] });
    const outbox: OutboxEntry[] = [];
    workflow.notifier = testNotifier(outbox, { tracker });
    const author = seedTask(workflow, { issue_id: "ENG-1" }, { prompt_in_flight: 1 });
    await run({ workflow, tracker, outbox, author });
  });

function stored(fixture: Fixture): AgentActivityContent[] {
  return fixture.tracker.stored.map((activity) => activity.content);
}

async function stream(fixture: Fixture, updates: SessionUpdate[]): Promise<void> {
  for (const update of updates) {
    await streamToSessionFeed(fixture.workflow, fixture.author, update);
  }
}

function triedIds(fixture: Fixture): string[] {
  return fixture.outbox.flatMap((entry) =>
    entry.channel === "feed" && entry.kind !== "delivery_error"
      ? [(entry.payload as { id: string }).id]
      : [],
  );
}

describe("the session feed", () => {
  describe("a tool call", () => {
    it("posts one action under its title when it completes", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [edit("c1", "login.ts")]);
        expect(stored(fixture)).toEqual([]);
        await stream(fixture, [ended("c1", "completed")]);
        expect(stored(fixture)).toEqual([
          { type: "action", action: "Edited", parameter: "login.ts" },
        ]);
      }));

    it("posts as failed when it fails", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [edit("c1", "login.ts"), ended("c1", "failed")]);
        expect(stored(fixture)).toEqual([
          { type: "action", action: "Edited", parameter: "login.ts", result: "failed" },
        ]);
      }));

    it("posts nothing when it completes after a restart lost its title", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [edit("c1", "login.ts")]);
        fixture.workflow.sessionFeeds.clear();
        await stream(fixture, [ended("c1", "completed")]);
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("thoughts and messages mid-turn", () => {
    it("post nothing", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [think("Look at login."), say("Opened PR #12.")]);
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("a turn that leaves the author idle", () => {
    it("closes with the author's last message as the reply", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Looking. "), edit("c1", "a.ts"), say("Opened "), say("#12.")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([{ type: "response", body: "Opened #12." }]);
        expect(fixture.workflow.sessionFeeds.size).toBe(0);
      }));

    it("closes with the done reply when a tool call came after the last message", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Opened #12."), edit("c1", "a.ts")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([{ type: "response", body: DONE_TEXT }]);
      }));

    it("closes a stopped turn with the stopped reply, after a message too", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Half done.")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("cancelled"));
        expect(stored(fixture)).toEqual([{ type: "response", body: STOPPED_TEXT }]);
      }));

    it("closes a turn cut off by a limit with an error", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Half done.")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("max_tokens"));
        expect(stored(fixture)).toEqual([
          { type: "error", body: "The turn ended on max_tokens before the work was complete." },
        ]);
      }));

    it("falls back to the done reply after a restart lost the last message", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Opened #12.")]);
        fixture.workflow.sessionFeeds.clear();
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([{ type: "response", body: DONE_TEXT }]);
      }));
  });

  describe("a turn that ends with a prompt queued", () => {
    it("posts no closing and forgets the last message", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Opened #12.")]);
        await closeSessionFeed(fixture.workflow, fixture.author, null);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([{ type: "response", body: DONE_TEXT }]);
      }));
  });

  describe("an author task that ends for good mid-turn", () => {
    it("closes the feed with the closing it is given", () =>
      linearOnly(async (fixture) => {
        await closeAbandonedTurnFeed(fixture.workflow, fixture.author, {
          kind: "error",
          text: "The task failed: no progress.",
        });
        expect(stored(fixture)).toEqual([{ type: "error", body: "The task failed: no progress." }]);
      }));

    it("posts nothing when its author is idle", () =>
      linearOnly(async (fixture) => {
        fixture.workflow.store.updateSandbox(fixture.author.task_id, { prompt_in_flight: 0 });
        await closeAbandonedTurnFeed(fixture.workflow, fixture.author, STOPPED_CLOSING);
        expect(stored(fixture)).toEqual([]);
      }));

    it("closes the feed when a resumed prompt waits for the sandbox", () =>
      linearOnly(async (fixture) => {
        fixture.workflow.store.updateSandbox(fixture.author.task_id, { prompt_in_flight: 0 });
        fixture.workflow.store.enqueuePrompt(fixture.author.task_id, "Continue.");
        await closeAbandonedTurnFeed(fixture.workflow, fixture.author, STOPPED_CLOSING);
        expect(stored(fixture)).toEqual([{ type: "response", body: STOPPED_TEXT }]);
      }));
  });

  describe("a post the tracker refuses once", () => {
    it("is tried again under the same id and posts once", () =>
      linearOnly(async (fixture) => {
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(fixture.tracker.stored).toHaveLength(1);
        expect(triedIds(fixture)).toEqual([fixture.tracker.stored[0]!.id!]);
      }, new FailingFirstTracker()));
  });

  describe("a post the tracker stores before it fails", () => {
    it("is held once", () =>
      linearOnly(async (fixture) => {
        fixture.tracker.health = "fails_after_storing";
        await stream(fixture, [edit("c1", "a.ts"), ended("c1", "completed")]);
        expect(stored(fixture)).toEqual([{ type: "action", action: "Edited", parameter: "a.ts" }]);
      }));
  });

  describe("a post that fails every attempt", () => {
    it("is dropped, and the closing is still tried", () =>
      linearOnly(async (fixture) => {
        fixture.tracker.health = "fails_before_storing";
        await stream(fixture, [edit("c1", "a.ts"), ended("c1", "completed")]);
        const errors = fixture.outbox.filter((entry) => entry.kind === "delivery_error");
        expect(errors).toHaveLength(FEED_POST_ATTEMPTS);
        fixture.tracker.health = "up";
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([{ type: "response", body: DONE_TEXT }]);
      }));
  });

  describe("every post", () => {
    it("is recorded on the feed channel, apart from orchestrator posts", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [edit("c1", "a.ts"), ended("c1", "completed")]);
        expect(fixture.outbox.map((entry) => entry.channel)).toEqual(["feed"]);
        expect(fixture.workflow.store.postedCount()).toBe(0);
      }));
  });

  describe("a role other than the author", () => {
    it("posts nothing", () =>
      linearOnly(async (fixture) => {
        const reviewer = { ...fixture.author, role: "reviewer" as const };
        await streamToSessionFeed(fixture.workflow, reviewer, edit("c1", "a.ts"));
        await streamToSessionFeed(fixture.workflow, reviewer, ended("c1", "completed"));
        await closeSessionFeed(fixture.workflow, reviewer, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("an author without a job session", () => {
    it("posts nothing", () =>
      linearOnly(async (fixture) => {
        fixture.workflow.patchState({ origin: THREAD, reply_targets: [THREAD] });
        await stream(fixture, [edit("c1", "a.ts"), ended("c1", "completed")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("an author whose job's input is not an issue, in a workflow started from a session", () => {
    it("posts nothing to the starting session", () =>
      linearOnly(async (fixture) => {
        const author = seedTask(fixture.workflow, { task_id: "wf_x.2" }, { prompt_in_flight: 1 });
        await stream({ ...fixture, author }, [edit("c1", "a.ts"), ended("c1", "completed")]);
        await closeSessionFeed(fixture.workflow, author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([]);
      }));
  });
});

describe("publishSessionPlan", () => {
  const entries = [
    { content: "Read the code", priority: "medium", status: "completed" },
    { content: "Fix it", priority: "medium", status: "in_progress" },
  ] as const;

  it("shows the todo list in the job session of a workflow without a chat thread", () =>
    linearOnly(async (fixture) => {
      fixture.workflow.store.setTodos(fixture.author.task_id, { entries: [...entries] });
      await publishSessionPlan(fixture.workflow, fixture.author);
      expect(fixture.tracker.argsOf("setSessionPlan")).toEqual([
        [
          "s-start",
          [
            { content: "Read the code", status: "completed" },
            { content: "Fix it", status: "inProgress" },
          ],
        ],
      ]);
    }));

  it("leaves the session without a plan when a chat thread exists", () =>
    linearOnly(async (fixture) => {
      fixture.workflow.patchState({ reply_targets: [STARTING, THREAD] });
      fixture.workflow.store.setTodos(fixture.author.task_id, { entries: [...entries] });
      await publishSessionPlan(fixture.workflow, fixture.author);
      expect(fixture.tracker.argsOf("setSessionPlan")).toEqual([]);
    }));

  it("leaves the starting session without a plan when the job's input is not an issue", () =>
    linearOnly(async (fixture) => {
      const author = seedTask(fixture.workflow, { task_id: "wf_x.2" });
      fixture.workflow.store.setTodos(author.task_id, { entries: [...entries] });
      await publishSessionPlan(fixture.workflow, author);
      expect(fixture.tracker.argsOf("setSessionPlan")).toEqual([]);
    }));
});

describe("sessionPlanOf", () => {
  it("maps a pending entry to a pending step", () => {
    expect(sessionPlanOf([{ content: "x", priority: "low", status: "pending" }])).toEqual([
      { content: "x", status: "pending" },
    ]);
  });
});
