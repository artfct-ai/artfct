import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ActivityOptions, AgentActivityContent } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "bun:test";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { testNotifier } from "../../../test/notifier-fixture";
import { SessionTracker } from "../../../test/session-tracker";
import { FEED_POST_ATTEMPTS, type OutboxEntry } from "../../notify/notifier";
import type { TodoSnapshot } from "../board/types";
import type { TaskRow } from "../store/tasks";
import {
  DONE_TEXT,
  HEARTBEAT_AFTER_MS,
  NARRATION_INTERVAL_MS,
  RECEIPT_TEXT,
  SESSION_FEED_TICK_SECONDS,
  STILL_WORKING_TEXT,
  STOPPED_CLOSING,
  STOPPED_TEXT,
  closeAbandonedTurnFeed,
  closeSessionFeed,
  feedClosingOf,
  postReceipt,
  publishSessionPlan,
  sessionPlanOf,
  startSessionFeedTurn,
  streamToSessionFeed,
  tendSessionFeed,
} from "./feed";

const STARTING = {
  source: "tracker",
  session_id: "s-start",
  issue_id: "ENG-1",
} as const satisfies ReplyTarget;
const TURN_START = Date.parse("2026-10-20T12:00:00.000Z");
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
    workflow.trackerInstance = tracker;
    workflow.clock = TURN_START;
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

function ephemeralFlags(fixture: Fixture): boolean[] {
  return fixture.tracker.stored.map((activity) => activity.ephemeral);
}

function at(fixture: Fixture, msAfterTurnStart: number): void {
  fixture.workflow.clock = TURN_START + msAfterTurnStart;
}

const FIX_IT_TODOS: TodoSnapshot = {
  entries: [
    { content: "Read the code", priority: "medium", status: "completed" },
    { content: "Fix it", priority: "medium", status: "in_progress" },
  ],
};

function triedIds(fixture: Fixture): string[] {
  return fixture.outbox.flatMap((entry) =>
    entry.channel === "feed" && entry.kind !== "delivery_error"
      ? [(entry.payload as { id: string }).id]
      : [],
  );
}

describe("the session feed", () => {
  describe("a tool call", () => {
    it("posts nothing, completed or failed", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [edit("c1", "login.ts"), ended("c1", "completed")]);
        await stream(fixture, [edit("c2", "login.ts"), ended("c2", "failed")]);
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("thoughts and messages mid-turn", () => {
    it("post nothing before a tool call", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [think("Look at login."), say("Opened PR #12.")]);
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("narration", () => {
    it("posts the message before a tool call as a persistent thought", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [
          say("The login check skips "),
          say("expired tokens."),
          edit("c1", "a.ts"),
        ]);
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "The login check skips expired tokens." },
        ]);
        expect(ephemeralFlags(fixture)).toEqual([false]);
      }));

    it("waits out its interval, then merges every line that waited in order", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [
          say("First."),
          edit("c1", "a.ts"),
          say("Second."),
          edit("c2", "a.ts"),
        ]);
        at(fixture, NARRATION_INTERVAL_MS - 1);
        await stream(fixture, [say("Third."), edit("c3", "a.ts")]);
        expect(stored(fixture)).toEqual([{ type: "thought", body: "First." }]);
        at(fixture, NARRATION_INTERVAL_MS);
        await stream(fixture, [say("Fourth."), edit("c4", "a.ts")]);
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "First." },
          { type: "thought", body: "Second.\n\nThird.\n\nFourth." },
        ]);
      }));

    it("posts what waits before the closing reply, which it does not repeat", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [
          say("First."),
          edit("c1", "a.ts"),
          say("Second."),
          edit("c2", "a.ts"),
        ]);
        await stream(fixture, [say("Opened #12.")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "First." },
          { type: "thought", body: "Second." },
          { type: "response", body: "Opened #12." },
        ]);
      }));

    it("keeps waiting when the tracker refuses every attempt", () =>
      linearOnly(async (fixture) => {
        fixture.tracker.health = "fails_before_storing";
        await stream(fixture, [say("First."), edit("c1", "a.ts")]);
        fixture.tracker.health = "up";
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "First." },
          { type: "response", body: DONE_TEXT },
        ]);
      }));

    it("survives a restart and posts on the next tick that finds it due", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [
          say("First."),
          edit("c1", "a.ts"),
          say("Second."),
          edit("c2", "a.ts"),
        ]);
        const restarted = fixture.workflow.restarted();
        at({ ...fixture, workflow: restarted }, NARRATION_INTERVAL_MS);
        await tendSessionFeed(restarted, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "First." },
          { type: "thought", body: "Second." },
        ]);
      }));
  });

  describe("a heartbeat", () => {
    it("names the step in progress after a quiet stretch, as an ephemeral thought", () =>
      linearOnly(async (fixture) => {
        fixture.workflow.store.setTodos(fixture.author.task_id, structuredClone(FIX_IT_TODOS));
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        at(fixture, HEARTBEAT_AFTER_MS - 1);
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([]);
        at(fixture, HEARTBEAT_AFTER_MS);
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([{ type: "thought", body: "Working on: Fix it" }]);
        expect(ephemeralFlags(fixture)).toEqual([true]);
      }));

    it("says the author is still working without a step in progress", () =>
      linearOnly(async (fixture) => {
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        at(fixture, HEARTBEAT_AFTER_MS);
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([{ type: "thought", body: STILL_WORKING_TEXT }]);
      }));

    it("is skipped while the tracker's request quota is low, and narration waits", () =>
      linearOnly(async (fixture) => {
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        await stream(fixture, [say("First."), edit("c1", "a.ts")]);
        fixture.tracker.quota = { remaining: 499, limit: 5000, resets_at: TURN_START + 3_600_000 };
        await stream(fixture, [say("Second."), edit("c2", "a.ts")]);
        at(fixture, NARRATION_INTERVAL_MS + HEARTBEAT_AFTER_MS);
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([{ type: "thought", body: "First." }]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "First." },
          { type: "thought", body: "Second." },
          { type: "response", body: DONE_TEXT },
        ]);
      }));

    it("posts again once the quota resets", () =>
      linearOnly(async (fixture) => {
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        fixture.tracker.quota = {
          remaining: 0,
          limit: 5000,
          resets_at: TURN_START + HEARTBEAT_AFTER_MS,
        };
        at(fixture, HEARTBEAT_AFTER_MS);
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([{ type: "thought", body: STILL_WORKING_TEXT }]);
      }));
  });

  describe("the feed's tick", () => {
    it("repeats while the turn is in flight and stops after it", () =>
      linearOnly(async (fixture) => {
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        const ticks = fixture.workflow.alarmsFor("tendSessionFeed");
        expect(ticks.map((tick) => [tick.delay, tick.repeats])).toEqual([
          [SESSION_FEED_TICK_SECONDS, true],
        ]);
        fixture.workflow.store.updateSandbox(fixture.author.task_id, { prompt_in_flight: 0 });
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(fixture.workflow.alarmsFor("tendSessionFeed")).toEqual([]);
      }));

    it("does not start for an author without a job session", () =>
      linearOnly(async (fixture) => {
        fixture.workflow.patchState({ origin: THREAD, reply_targets: [THREAD] });
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        expect(fixture.workflow.alarmsFor("tendSessionFeed")).toEqual([]);
      }));
  });

  describe("a receipt", () => {
    it("tells the person in an ephemeral thought, and counts as activity", () =>
      linearOnly(async (fixture) => {
        await startSessionFeedTurn(fixture.workflow, fixture.author);
        at(fixture, HEARTBEAT_AFTER_MS - 1);
        await postReceipt(fixture.workflow, STARTING);
        at(fixture, HEARTBEAT_AFTER_MS);
        await tendSessionFeed(fixture.workflow, { task_id: fixture.author.task_id });
        expect(stored(fixture)).toEqual([{ type: "thought", body: RECEIPT_TEXT }]);
        expect(ephemeralFlags(fixture)).toEqual([true]);
      }));
  });

  describe("a turn that leaves the author idle", () => {
    it("closes with the author's last message as the reply", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Looking. "), edit("c1", "a.ts"), say("Opened "), say("#12.")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "Looking." },
          { type: "response", body: "Opened #12." },
        ]);
        expect(fixture.workflow.sessionFeeds.size).toBe(0);
      }));

    it("closes with the done reply when a tool call came after the last message", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Opened #12."), edit("c1", "a.ts")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([
          { type: "thought", body: "Opened #12." },
          { type: "response", body: DONE_TEXT },
        ]);
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
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([{ type: "response", body: DONE_TEXT }]);
      }));
  });

  describe("a post that fails every attempt", () => {
    it("is dropped after its attempts", () =>
      linearOnly(async (fixture) => {
        fixture.tracker.health = "fails_before_storing";
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        const errors = fixture.outbox.filter((entry) => entry.kind === "delivery_error");
        expect(errors).toHaveLength(FEED_POST_ATTEMPTS);
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("every post", () => {
    it("is recorded on the feed channel, apart from orchestrator posts", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("First."), edit("c1", "a.ts")]);
        expect(fixture.outbox.map((entry) => entry.channel)).toEqual(["feed"]);
        expect(fixture.workflow.store.postedCount()).toBe(0);
      }));
  });

  describe("a role other than the author", () => {
    it("posts nothing", () =>
      linearOnly(async (fixture) => {
        const reviewer = { ...fixture.author, role: "reviewer" as const };
        await streamToSessionFeed(fixture.workflow, reviewer, say("First."));
        await streamToSessionFeed(fixture.workflow, reviewer, edit("c1", "a.ts"));
        await closeSessionFeed(fixture.workflow, reviewer, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("an author without a job session", () => {
    it("posts nothing", () =>
      linearOnly(async (fixture) => {
        fixture.workflow.patchState({ origin: THREAD, reply_targets: [THREAD] });
        await stream(fixture, [say("First."), edit("c1", "a.ts")]);
        await closeSessionFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(stored(fixture)).toEqual([]);
      }));
  });

  describe("an author whose job's input is not an issue, in a workflow started from a session", () => {
    it("posts nothing to the starting session", () =>
      linearOnly(async (fixture) => {
        const author = seedTask(fixture.workflow, { task_id: "wf_x.2" }, { prompt_in_flight: 1 });
        await stream({ ...fixture, author }, [say("First."), edit("c1", "a.ts")]);
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
