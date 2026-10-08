import type { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { fakeSlack, testNotifier } from "../../test/notifier-fixture";
import { TRACKER_RELEASE_TEXT, Notifier, type OutboxEntry } from "./notifier";

const target = { source: "chat", channel: "C1", thread: "1.0" } as const;

const linearTarget = {
  source: "tracker",
  session_id: "sess-1",
  issue_id: "issue-1",
  team_id: "team-1",
} as const;

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("Notifier.acknowledge", () => {
  let outbox: OutboxEntry[];

  beforeEach(() => {
    outbox = [];
  });

  describe("a Slack message with a title and a user", () => {
    let chat: FakeChat;

    beforeEach(async () => {
      chat = fakeSlack();
      await testNotifier(outbox, { chat }).acknowledge(
        target,
        { message: "2.0", user: "U1" },
        "Fix the test",
      );
    });

    it("sets the processing status and adds no reaction", () => {
      expect(chat.calls).toEqual([
        {
          method: "setSessionStatus",
          args: ["C1", "1.0", "processing", { title: "Fix the test", initiatorUserId: "U1" }],
        },
      ]);
    });

    it("records the acknowledgement in the outbox", () => {
      expect(outbox).toEqual([
        {
          channel: "chat",
          kind: "acknowledge",
          target,
          payload: { message: "2.0", user: "U1", title: "Fix the test" },
        },
      ]);
    });
  });

  describe("when the status call fails", () => {
    let chat: FakeChat;
    let warn: ReturnType<typeof spyOnWarn>;
    let acknowledged: Promise<void>;

    beforeEach(() => {
      chat = fakeSlack(["setSessionStatus"]);
      warn = spyOnWarn();
      acknowledged = testNotifier(outbox, { chat }).acknowledge(
        target,
        { message: "2.0" },
        "Fix the test",
      );
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("never throws", async () => {
      await expect(acknowledged).resolves.toBeUndefined();
    });

    it("warns once", async () => {
      await acknowledged;
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("tries the status call and nothing else", async () => {
      await acknowledged;
      expect(chat.calls.map((call) => call.method)).toEqual(["setSessionStatus"]);
    });

    it("still records the acknowledgement", async () => {
      await acknowledged;
      expect(outbox).toHaveLength(1);
    });
  });

  describe("without a Slack client", () => {
    it("only writes the outbox", async () => {
      await testNotifier(outbox).acknowledge(target, { message: "2.0" }, "Fix the test");
      expect(outbox.map((entry) => entry.kind)).toEqual(["acknowledge"]);
    });
  });
});

describe("Notifier.working", () => {
  let outbox: OutboxEntry[];

  beforeEach(() => {
    outbox = [];
  });

  describe("a line about the current step on a Slack thread", () => {
    let chat: FakeChat;

    beforeEach(async () => {
      chat = fakeSlack();
      await testNotifier(outbox, { chat }).working(target, "Step 2: get issue");
    });

    it("retitles the processing status and posts no message", () => {
      expect(chat.calls).toEqual([
        {
          method: "setSessionStatus",
          args: ["C1", "1.0", "processing", { title: "Step 2: get issue" }],
        },
      ]);
    });

    it("records the line in the outbox", () => {
      expect(outbox).toEqual([
        { channel: "chat", kind: "working", target, payload: { text: "Step 2: get issue" } },
      ]);
    });
  });

  describe("the same line on a Linear session", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker();
      await testNotifier(outbox, { tracker }).working(linearTarget, "Step 2: get issue");
    });

    it("posts an ephemeral thought", () => {
      expect(tracker.argsOf("activity")).toEqual([
        ["sess-1", { type: "thought", body: "Step 2: get issue" }, { ephemeral: true }],
      ]);
    });

    it("records the line in the outbox", () => {
      expect(outbox.map((entry) => entry.kind)).toEqual(["working"]);
    });
  });

  describe("when the Slack status call fails", () => {
    let warn: ReturnType<typeof spyOnWarn>;
    let working: Promise<void>;

    beforeEach(() => {
      warn = spyOnWarn();
      working = testNotifier(outbox, { chat: fakeSlack(["setSessionStatus"]) }).working(
        target,
        "Step 1: ask",
      );
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("never throws", async () => {
      await expect(working).resolves.toBeUndefined();
    });

    it("warns that the status call failed", async () => {
      await working;
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("chat session status processing failed"),
      );
    });
  });
});

describe("Notifier.release", () => {
  let outbox: OutboxEntry[];

  beforeEach(() => {
    outbox = [];
  });

  describe("a Slack thread on a workflow that still accepts work", () => {
    let chat: FakeChat;

    beforeEach(async () => {
      chat = fakeSlack();
      await testNotifier(outbox, { chat }).release(target, false, "Flaky checkout test");
    });

    it("sets the session active on the workflow name, without a message", () => {
      expect(chat.calls).toEqual([
        {
          method: "setSessionStatus",
          args: ["C1", "1.0", "active", { title: "Flaky checkout test" }],
        },
      ]);
    });

    it("records the release in the outbox", () => {
      expect(outbox).toEqual([
        { channel: "chat", kind: "release", target, payload: { finished: false } },
      ]);
    });
  });

  describe("a Slack thread the turn wrote an activity line over", () => {
    let chat: FakeChat;

    beforeEach(async () => {
      chat = fakeSlack();
      const notifier = testNotifier(outbox, { chat });
      await notifier.working(target, "Step 3: start task");
      await notifier.release(target, false, "Flaky checkout test");
    });

    it("leaves the thread on the name and not on the last step", () => {
      expect(chat.argsOf("setSessionStatus").map((args) => args[3])).toEqual([
        { title: "Step 3: start task" },
        { title: "Flaky checkout test" },
      ]);
    });
  });

  describe("a Linear session on a finished workflow", () => {
    let tracker: FakeTracker;
    let subject: Notifier;

    beforeEach(async () => {
      tracker = new FakeTracker();
      subject = testNotifier(outbox, { tracker });
      await subject.release(linearTarget, true, "Flaky checkout test");
    });

    it("says nothing, since the workflow said its last word", () => {
      expect(tracker.calls).toHaveLength(0);
    });

    describe("and then released while the workflow runs", () => {
      beforeEach(async () => {
        await subject.release(linearTarget, false, "Flaky checkout test");
      });

      it("closes the session with a short response", () => {
        expect(tracker.argsOf("activity")).toEqual([
          ["sess-1", { type: "response", body: TRACKER_RELEASE_TEXT }, {}],
        ]);
      });

      it("records one release in the outbox", () => {
        expect(outbox.map((entry) => entry.kind)).toEqual(["release"]);
      });
    });
  });
});
