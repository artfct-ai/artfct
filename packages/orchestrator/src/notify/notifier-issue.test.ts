import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { beforeEach, describe, expect, it } from "bun:test";
import { testNotifier } from "../../test/notifier-fixture";
import type { Notifier, OutboxEntry } from "./notifier";

const linearTarget = {
  source: "tracker",
  session_id: "sess-1",
  issue_id: "issue-1",
  team_id: "team-1",
} as const;

describe("Notifier.moveIssue", () => {
  let tracker: FakeTracker;
  let outbox: OutboxEntry[];
  let subject: Notifier;

  beforeEach(() => {
    tracker = new FakeTracker();
    outbox = [];
    subject = testNotifier(outbox, { tracker });
  });

  describe("a target with a team", () => {
    beforeEach(async () => {
      await subject.moveIssue(linearTarget, "started");
    });

    it("reads the team states and moves the issue to the started one", () => {
      expect(tracker.calls).toEqual([
        { method: "teamStates", args: ["team-1"] },
        { method: "updateIssue", args: ["issue-1", { stateId: "st-progress" }] },
      ]);
    });

    describe("and then a target without a team", () => {
      beforeEach(async () => {
        await subject.moveIssue({ issue_id: "issue-1" }, "completed");
      });

      it("skips the tracker, which has no team to read states from", () => {
        expect(tracker.calls).toHaveLength(2);
      });

      it("records both transitions in the outbox", () => {
        expect(outbox.map((entry) => entry.payload)).toEqual([
          { to: "started", delegate: null },
          { to: "completed", delegate: null },
        ]);
      });
    });
  });

  describe("when the tracker fails", () => {
    let moved: Promise<void>;

    beforeEach(() => {
      moved = testNotifier(outbox, { tracker: new FakeTracker({ failing: true }) }).moveIssue(
        linearTarget,
        "started",
      );
    });

    it("never throws", async () => {
      await expect(moved).resolves.toBeUndefined();
    });

    it("records the update and a delivery error", async () => {
      await moved;
      expect(outbox.map((entry) => entry.kind)).toEqual(["issue_update", "delivery_error"]);
    });

    it("keeps the API error text in the delivery error", async () => {
      await moved;
      expect(outbox[1]?.payload).toMatch(/teamStates: boom/);
    });
  });
});

describe("Notifier.claimIssue", () => {
  const issue = { issue_id: "issue-1", team_id: "team-1" };
  let outbox: OutboxEntry[];

  beforeEach(() => {
    outbox = [];
  });

  describe("under the installed app, which knows the agent's own user", () => {
    let tracker: FakeTracker;
    let subject: Notifier;

    beforeEach(() => {
      tracker = new FakeTracker({ appUserId: "app1" });
      subject = testNotifier(outbox, { tracker });
    });

    describe("an issue that is not started yet", () => {
      beforeEach(async () => {
        await subject.claimIssue(issue, { started: false });
      });

      it("moves and delegates in one issueUpdate", () => {
        expect(tracker.calls).toEqual([
          { method: "teamStates", args: ["team-1"] },
          {
            method: "updateIssue",
            args: ["issue-1", { stateId: "st-progress", delegateId: "app1" }],
          },
        ]);
      });

      it("records the claim in the outbox", () => {
        expect(outbox.map((entry) => [entry.kind, entry.target, entry.payload])).toEqual([
          ["issue_update", issue, { to: "started", delegate: "app1" }],
        ]);
      });
    });

    describe("an issue that is already started", () => {
      beforeEach(async () => {
        await subject.claimIssue(issue, { started: true });
      });

      it("only delegates it", () => {
        expect(tracker.calls).toEqual([
          { method: "updateIssue", args: ["issue-1", { delegateId: "app1" }] },
        ]);
      });
    });
  });

  describe("under a personal API key, which has no agent user to delegate to", () => {
    let tracker: FakeTracker;
    let subject: Notifier;

    beforeEach(async () => {
      tracker = new FakeTracker();
      subject = testNotifier(outbox, { tracker });
      await subject.claimIssue(issue, { started: false });
    });

    it("only moves the issue", () => {
      expect(tracker.calls.at(-1)).toEqual({
        method: "updateIssue",
        args: ["issue-1", { stateId: "st-progress" }],
      });
    });

    it("records the claim without a delegate", () => {
      expect(outbox[0]?.payload).toEqual({ to: "started", delegate: null });
    });

    describe("and then an issue that is already started", () => {
      beforeEach(async () => {
        await subject.claimIssue(issue, { started: true });
      });

      it("has nothing left to update", () => {
        expect(tracker.calls).toHaveLength(2);
      });
    });
  });

  describe("without a client", () => {
    it("records the claim in the outbox", async () => {
      await testNotifier(outbox).claimIssue(
        { issue_id: "issue-2", team_id: null },
        { started: false },
      );
      expect(outbox).toEqual([
        {
          channel: "tracker",
          kind: "issue_update",
          target: { issue_id: "issue-2", team_id: null },
          payload: { to: "started", delegate: null },
        },
      ]);
    });
  });
});

describe("Notifier.linkChatThread", () => {
  const issue = { issue_id: "issue-1", team_id: "team-1" };
  const thread = { source: "chat", channel: "C1", thread: "1.2" } as const;
  let outbox: OutboxEntry[];

  beforeEach(() => {
    outbox = [];
  });

  describe("with both clients", () => {
    let chat: FakeChat;
    let tracker: FakeTracker;

    beforeEach(async () => {
      chat = new FakeChat({ permalinks: { "1.2": "https://acme.slack.com/archives/C1/p12" } });
      tracker = new FakeTracker();
      await testNotifier(outbox, { chat, tracker }).linkChatThread(issue, thread);
    });

    it("reads the permalink of the thread root", () => {
      expect(chat.calls).toEqual([{ method: "permalink", args: ["C1", "1.2"] }]);
    });

    it("attaches that link to the issue", () => {
      expect(tracker.calls).toEqual([
        { method: "attachUrl", args: ["issue-1", "https://acme.slack.com/archives/C1/p12"] },
      ]);
    });

    it("records the link in the outbox", () => {
      expect(outbox).toEqual([
        {
          channel: "tracker",
          kind: "attach_chat_thread",
          target: issue,
          payload: { channel: "C1", thread: "1.2" },
        },
      ]);
    });
  });

  describe("when the tracker fails", () => {
    let linked: Promise<void>;

    beforeEach(() => {
      linked = testNotifier(outbox, {
        chat: new FakeChat(),
        tracker: new FakeTracker({ failing: true }),
      }).linkChatThread(issue, thread);
    });

    it("never throws", async () => {
      await expect(linked).resolves.toBeUndefined();
    });

    it("records the attempt and a delivery error", async () => {
      await linked;
      expect(outbox.map((entry) => entry.kind)).toEqual(["attach_chat_thread", "delivery_error"]);
    });
  });

  describe("without a chat client", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker();
      await testNotifier(outbox, { tracker }).linkChatThread(issue, thread);
    });

    it("attaches nothing, since there is no link to read", () => {
      expect(tracker.calls).toEqual([]);
    });

    it("still records the attempt in the outbox", () => {
      expect(outbox.map((entry) => entry.kind)).toEqual(["attach_chat_thread"]);
    });
  });
});
