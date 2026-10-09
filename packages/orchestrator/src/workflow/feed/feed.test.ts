import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ActivityOptions, AgentActivityContent } from "@artfct-ai/adapters/tracker/types";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { describe, expect, it } from "bun:test";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { testNotifier } from "../../../test/notifier-fixture";
import { scenario } from "../../../test/scenario";
import { activityText, SessionTracker } from "../../../test/session-tracker";
import type { OutboxEntry } from "../../notify/notifier";
import type { TaskRow } from "../store/tasks";
import {
  DONE_TEXT,
  FEED_INTERVAL_MS,
  STOPPED_TEXT,
  feedClosingOf,
  flushFeed,
  publishSessionPlan,
  recordFeedUpdate,
  sessionPlanOf,
} from "./feed";

const STARTING: ReplyTarget = { source: "tracker", session_id: "s-start", issue_id: "ENG-1" };
const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };
const START = 1_000_000;

const say = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const think = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const read = (id: string, title: string): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  kind: "read",
});

class FailingFirstTracker extends SessionTracker {
  private activities = 0;

  override async activity(
    sessionId: string,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    this.activities += 1;
    if (this.activities === 1) throw new Error("tracker unavailable");
    await super.activity(sessionId, content, options);
  }
}

type Fixture = {
  workflow: FakeRuntime;
  tracker: FakeTracker;
  outbox: OutboxEntry[];
  author: TaskRow;
};

function withTracker(workflow: FakeRuntime, tracker: FakeTracker, outbox: OutboxEntry[]): void {
  workflow.notifier = testNotifier(outbox, { tracker });
}

const linearOnly = (run: (fixture: Fixture) => Promise<void>) =>
  freshRuntime(async (workflow) => {
    workflow.patchState({ origin: STARTING, reply_targets: [STARTING] });
    workflow.clock = START;
    const tracker = new FakeTracker();
    const outbox: OutboxEntry[] = [];
    withTracker(workflow, tracker, outbox);
    await run({ workflow, tracker, outbox, author: seedTask(workflow) });
  });

function posted(tracker: FakeTracker): unknown[] {
  return tracker.argsOf("activity").map((args) => args[1]);
}

async function stream(fixture: Fixture, updates: SessionUpdate[]): Promise<void> {
  for (const update of updates) {
    recordFeedUpdate(fixture.workflow, fixture.author, update);
    await flushFeed(fixture.workflow, fixture.author);
  }
}

describe("the session feed", () => {
  describe("text the author streams", () => {
    it("joins chunks of one message into one item, held until something follows it", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [say("Opened "), say("PR #12.")]);
        expect(posted(fixture.tracker)).toEqual([]);
        expect(fixture.workflow.store.feedItems(fixture.author.task_id)).toMatchObject([
          { kind: "message", text: "Opened PR #12." },
        ]);
      }));

    it("posts a thought once a tool call follows it", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [think("Look at login."), read("c1", "src/login.ts")]);
        expect(posted(fixture.tracker)).toEqual([
          {
            type: "thought",
            body: "Look at login.\n\n- Read: src/login.ts",
          },
        ]);
      }));
  });

  describe("posts inside one interval", () => {
    it("hold the items for the next flush after the interval", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [read("c1", "a.ts")]);
        await stream(fixture, [read("c2", "b.ts"), read("c3", "c.ts")]);
        expect(posted(fixture.tracker)).toHaveLength(1);
        fixture.workflow.clock = START + FEED_INTERVAL_MS;
        await flushFeed(fixture.workflow, fixture.author);
        expect(posted(fixture.tracker)).toEqual([
          { type: "action", action: "Read", parameter: "a.ts" },
          { type: "thought", body: "- Read: b.ts\n\n- Read: c.ts" },
        ]);
      }));
  });

  describe("a tool call that fails before its item posts", () => {
    it("posts as failed", () =>
      linearOnly(async (fixture) => {
        recordFeedUpdate(fixture.workflow, fixture.author, read("c1", "a.ts"));
        recordFeedUpdate(fixture.workflow, fixture.author, {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "failed",
        });
        await flushFeed(fixture.workflow, fixture.author);
        expect(posted(fixture.tracker)).toEqual([
          { type: "action", action: "Read", parameter: "a.ts", result: "failed" },
        ]);
      }));
  });

  describe("a turn that leaves the author idle", () => {
    it("closes with the author's last message as the reply", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [read("c1", "a.ts"), say("Opened PR #12.")]);
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(posted(fixture.tracker).at(-1)).toEqual({
          type: "response",
          body: "Opened PR #12.",
        });
        expect(fixture.workflow.store.feedItems(fixture.author.task_id)).toEqual([]);
      }));

    it("closes a stop without a last message with the stopped reply", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [read("c1", "a.ts")]);
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("cancelled"));
        expect(posted(fixture.tracker).at(-1)).toEqual({ type: "response", body: STOPPED_TEXT });
      }));

    it("closes a finished turn without anything said with the done reply", () =>
      linearOnly(async (fixture) => {
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(posted(fixture.tracker)).toEqual([{ type: "response", body: DONE_TEXT }]);
      }));

    it("closes a turn cut off by a limit with an error, inside the interval too", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [read("c1", "a.ts"), read("c2", "b.ts"), say("Half done.")]);
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("max_tokens"));
        expect(posted(fixture.tracker).slice(1)).toEqual([
          { type: "thought", body: "- Read: b.ts\n\nHalf done." },
          { type: "error", body: "The turn ended on max_tokens before the work was complete." },
        ]);
      }));
  });

  describe("a post the tracker refuses", () => {
    it("is sent again later under the same id", () =>
      linearOnly(async (fixture) => {
        const linear = new SessionTracker();
        withTracker(fixture.workflow, linear, fixture.outbox);
        linear.health = "fails_before_storing";
        await stream(fixture, [read("c1", "a.ts")]);
        linear.health = "up";
        fixture.workflow.clock = START + FEED_INTERVAL_MS;
        await flushFeed(fixture.workflow, fixture.author);
        const tried = fixture.outbox.flatMap((entry) =>
          entry.kind === "action" ? [(entry.payload as { id: string }).id] : [],
        );
        expect(tried).toHaveLength(2);
        expect(new Set(tried).size).toBe(1);
        expect(linear.stored.map((activity) => activity.id)).toEqual([tried[0]!]);
        expect(fixture.workflow.store.feedPosts(fixture.author.task_id)).toEqual([]);
      }));
  });

  describe("a post the tracker stored before it failed", () => {
    it("is sent again as it was, and items streamed after it post apart", () =>
      linearOnly(async (fixture) => {
        const linear = new SessionTracker();
        withTracker(fixture.workflow, linear, fixture.outbox);
        linear.health = "fails_after_storing";
        await stream(fixture, [read("c1", "a.ts")]);
        linear.health = "up";
        await stream(fixture, [read("c2", "b.ts")]);
        fixture.workflow.clock = START + FEED_INTERVAL_MS;
        await flushFeed(fixture.workflow, fixture.author);
        fixture.workflow.clock = START + 2 * FEED_INTERVAL_MS;
        await flushFeed(fixture.workflow, fixture.author);
        expect(linear.stored.map((activity) => activityText(activity.content))).toEqual([
          "Read a.ts ",
          "Read b.ts ",
        ]);
      }));
  });

  describe("a closing after a post that failed", () => {
    it("replaces the failed post and stays within two posts", () =>
      linearOnly(async (fixture) => {
        const linear = new SessionTracker();
        withTracker(fixture.workflow, linear, fixture.outbox);
        linear.health = "fails_before_storing";
        await stream(fixture, [read("c1", "a.ts")]);
        linear.health = "up";
        await stream(fixture, [read("c2", "b.ts"), say("Opened PR #12.")]);
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(linear.stored.map((activity) => activity.content)).toEqual([
          { type: "action", action: "Read", parameter: "b.ts" },
          { type: "response", body: "Opened PR #12." },
        ]);
      }));
  });

  describe("a closing whose earlier activity fails", () => {
    it("drops that activity and still posts the closing reply", () =>
      linearOnly(async (fixture) => {
        const linear = new FailingFirstTracker();
        withTracker(fixture.workflow, linear, fixture.outbox);
        await stream(fixture, [think("Look at login."), read("c1", "a.ts")]);
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        expect(linear.stored.map((activity) => activity.content)).toEqual([
          { type: "response", body: DONE_TEXT },
        ]);
        expect(fixture.workflow.store.feedPosts(fixture.author.task_id)).toEqual([]);
      }));
  });

  describe("a closing reply that fails", () => {
    it("is kept and sent again by the next flush", () =>
      linearOnly(async (fixture) => {
        const linear = new SessionTracker();
        withTracker(fixture.workflow, linear, fixture.outbox);
        linear.health = "fails_before_storing";
        await flushFeed(fixture.workflow, fixture.author, feedClosingOf("end_turn"));
        linear.health = "up";
        fixture.workflow.clock = START + FEED_INTERVAL_MS;
        await flushFeed(fixture.workflow, fixture.author);
        expect(linear.stored.map((activity) => activity.content)).toEqual([
          { type: "response", body: DONE_TEXT },
        ]);
      }));
  });

  describe("every post", () => {
    it("is recorded on the feed channel, apart from orchestrator posts", () =>
      linearOnly(async (fixture) => {
        await stream(fixture, [read("c1", "a.ts")]);
        expect(fixture.outbox.map((entry) => entry.channel)).toEqual(["feed"]);
        expect(fixture.workflow.store.postedCount()).toBe(0);
      }));
  });

  describe("a role other than the author", () => {
    it("keeps nothing", () =>
      linearOnly(async (fixture) => {
        const reviewer = { ...fixture.author, role: "reviewer" as const };
        recordFeedUpdate(fixture.workflow, reviewer, read("c1", "a.ts"));
        expect(fixture.workflow.store.feedItems(reviewer.task_id)).toEqual([]);
      }));
  });

  describe("an author without a job session", () => {
    const chatOnly = scenario(freshRuntime, (workflow) => {
      workflow.patchState({ origin: THREAD, reply_targets: [THREAD] });
      seedTask(workflow);
    });

    it("keeps nothing", () =>
      chatOnly(async (workflow) => {
        const author = workflow.store.tasks()[0]!;
        recordFeedUpdate(workflow, author, read("c1", "a.ts"));
        expect(workflow.store.feedItems(author.task_id)).toEqual([]);
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
});

describe("sessionPlanOf", () => {
  it("maps a pending entry to a pending step", () => {
    expect(sessionPlanOf([{ content: "x", priority: "low", status: "pending" }])).toEqual([
      { content: "x", status: "pending" },
    ]);
  });
});
