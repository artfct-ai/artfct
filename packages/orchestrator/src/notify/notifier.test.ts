import type { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { beforeEach, describe, expect, it } from "bun:test";
import { fakeSlack, testNotifier } from "../../test/notifier-fixture";
import { Notifier, CHAT_PROGRESS_INTERVAL_MS, type OutboxEntry } from "./notifier";
import { TAG_TO_START_AGAIN } from "./messages";

const target = { source: "chat", channel: "C1", thread: "1.0" } as const;

const linearTarget = {
  source: "tracker",
  session_id: "sess-1",
  issue_id: "issue-1",
  team_id: "team-1",
} as const;

describe("Notifier.post to Slack", () => {
  let chat: FakeChat;
  let outbox: OutboxEntry[];
  let subject: Notifier;
  const statuses = () => chat.argsOf("setSessionStatus").map((args) => args[2]);

  beforeEach(() => {
    chat = fakeSlack();
    outbox = [];
    subject = testNotifier(outbox, { chat });
  });

  describe("a done event while the workflow still accepts work", () => {
    beforeEach(async () => {
      await subject.post(target, { type: "done", result: "all good" });
    });

    it("leaves the session active", () => {
      expect(statuses()).toEqual(["active"]);
    });
  });

  describe("a failed event on a finished workflow", () => {
    beforeEach(async () => {
      await subject.post(target, { type: "workflow_failed", reason: "boom" }, { finished: true });
    });

    it("closes the session", () => {
      expect(statuses()).toEqual(["closed"]);
    });
  });

  describe("an info event on a finished workflow", () => {
    beforeEach(async () => {
      await subject.post(target, { type: "info", text: "Cancelled." }, { finished: true });
    });

    it("closes the session, which follows the workflow state and not the event", () => {
      expect(statuses()).toEqual(["closed"]);
    });
  });

  describe("a reply that ends a turn whose steps wrote over the title", () => {
    beforeEach(async () => {
      await subject.working(target, "Step 3: start task");
      await subject.post(
        target,
        { type: "info", text: "Opened the pull request." },
        { title: "Flaky checkout test" },
      );
    });

    it("leaves the thread on the workflow name", () => {
      expect(chat.argsOf("setSessionStatus").map((args) => args[3])).toEqual([
        { title: "Step 3: start task" },
        { title: "Flaky checkout test" },
      ]);
    });
  });

  describe("a post that keeps the session", () => {
    beforeEach(async () => {
      await subject.post(target, { type: "info", text: "done already" }, { keepSession: true });
    });

    it("posts the message and leaves the session alone", () => {
      expect(chat.calls.map((call) => call.method)).toEqual(["postThreadReply"]);
    });
  });

  describe("when the message itself fails", () => {
    beforeEach(async () => {
      chat = fakeSlack(["postThreadReply"]);
      await testNotifier(outbox, { chat }).post(
        target,
        { type: "info", text: "x".repeat(10) },
        { finished: true },
      );
    });

    it("sets the session status after the failed message", () => {
      expect(chat.calls.map((call) => call.method)).toEqual([
        "postThreadReply",
        "setSessionStatus",
      ]);
    });

    it("closes the session of the finished workflow", () => {
      expect(statuses()[0]).toBe("closed");
    });

    it("records the message and a delivery error", () => {
      expect(outbox.map((entry) => entry.kind)).toEqual(["info", "delivery_error"]);
    });

    it("keeps the API error text in the delivery error", () => {
      expect(outbox[1]?.payload).toContain("msg_too_long");
    });
  });
});

describe("Notifier.post to Linear", () => {
  let tracker: FakeTracker;
  let outbox: OutboxEntry[];
  let subject: Notifier;

  beforeEach(() => {
    tracker = new FakeTracker();
    outbox = [];
    subject = testNotifier(outbox, { tracker });
  });

  describe("a progress event", () => {
    beforeEach(async () => {
      await subject.post(linearTarget, { type: "progress", task_id: "t1", text: "compiling" });
    });

    it("posts it as an ephemeral action", () => {
      expect(tracker.argsOf("activity")).toEqual([
        [
          "sess-1",
          { type: "action", action: "working", parameter: "compiling" },
          { ephemeral: true, externalUrls: undefined },
        ],
      ]);
    });

    it("makes no other tracker call", () => {
      expect(tracker.calls).toHaveLength(1);
    });

    it("records the action in the outbox", () => {
      expect(outbox).toEqual([
        {
          channel: "tracker",
          kind: "action",
          target: linearTarget,
          payload: { type: "action", action: "working", parameter: "compiling", ephemeral: true },
        },
      ]);
    });
  });

  describe("an artifact that is ready", () => {
    beforeEach(async () => {
      await subject.post(linearTarget, {
        type: "artifact_ready",
        job_id: "j1",
        artifact_kind: "pull",
        url: "https://github.com/acme/app/pull/7",
        text: "The pull request is ready for you: https://github.com/acme/app/pull/7",
      });
    });

    it("attaches the artifact link as an external url", () => {
      expect(tracker.argsOf("activity")[0]?.[2]).toEqual({
        ephemeral: false,
        externalUrls: [{ url: "https://github.com/acme/app/pull/7", label: "pull" }],
      });
    });
  });

  describe("a done event", () => {
    beforeEach(async () => {
      await subject.post(linearTarget, { type: "done", result: "merged" });
    });

    it("leaves the issue where it is", () => {
      expect(tracker.argsOf("updateIssue")).toEqual([]);
    });
  });

  describe("when the tracker fails", () => {
    let posted: Promise<void>;

    beforeEach(() => {
      posted = testNotifier(outbox, { tracker: new FakeTracker({ failing: true }) }).post(
        linearTarget,
        { type: "info", text: "hello" },
      );
    });

    it("never throws", async () => {
      await expect(posted).resolves.toBeUndefined();
    });

    it("records the response and a delivery error", async () => {
      await posted;
      expect(outbox.map((entry) => entry.kind)).toEqual(["response", "delivery_error"]);
    });

    it("keeps the API error text in the delivery error", async () => {
      await posted;
      expect(outbox[1]?.payload).toMatch(/activity: boom/);
    });
  });
});

describe("Notifier.post to Notion", () => {
  const pageTarget = { source: "documents", page_id: "page-1" } as const;
  let documents: FakeDocuments;
  let outbox: OutboxEntry[];
  let subject: Notifier;

  beforeEach(() => {
    documents = new FakeDocuments();
    outbox = [];
    subject = testNotifier(outbox, { documents });
  });

  describe("a progress event", () => {
    beforeEach(async () => {
      await subject.post(pageTarget, { type: "progress", task_id: "t1", text: "compiling" });
    });

    it("comments nothing on the page", () => {
      expect(documents.calls).toEqual([]);
    });

    it("writes nothing to the outbox", () => {
      expect(outbox).toEqual([]);
    });

    describe("and then a done event", () => {
      beforeEach(async () => {
        await subject.post(pageTarget, { type: "done", result: "merged" });
      });

      it("comments its plain text on the page", () => {
        expect(documents.argsOf("comment")).toEqual([
          ["page-1", `Done. merged\n\n${TAG_TO_START_AGAIN}`],
        ]);
      });

      it("records only the comment in the outbox", () => {
        expect(outbox).toEqual([
          {
            channel: "documents",
            kind: "done",
            target: pageTarget,
            payload: { text: `Done. merged\n\n${TAG_TO_START_AGAIN}` },
          },
        ]);
      });
    });
  });
});

describe("Notifier.quiet", () => {
  let chat: FakeChat;
  let outbox: OutboxEntry[];
  let subject: Notifier;

  beforeEach(() => {
    chat = fakeSlack();
    outbox = [];
    subject = testNotifier(outbox, { chat });
  });

  describe("a progress event recorded as internal", () => {
    beforeEach(async () => {
      await subject.quiet(target, { type: "progress", task_id: "t1", text: "edit" }, "internal");
    });

    it("sends no message", () => {
      expect(chat.calls).toEqual([]);
    });

    it("records it under the internal channel", () => {
      expect(outbox).toEqual([
        { channel: "internal", kind: "progress", target, payload: { text: "edit" } },
      ]);
    });

    describe("and then a started event recorded on the board", () => {
      beforeEach(async () => {
        await subject.quiet(target, { type: "started", stage: "design", job_id: "j1" }, "board");
      });

      it("records it under the board channel with its plain text", () => {
        expect(outbox).toEqual([
          { channel: "internal", kind: "progress", target, payload: { text: "edit" } },
          {
            channel: "board",
            kind: "started",
            target,
            payload: { text: "Starting stage *design*." },
          },
        ]);
      });
    });
  });
});

describe("Slack progress throttle", () => {
  let clock: number;
  let chat: FakeChat;
  let outbox: OutboxEntry[];
  let subject: Notifier;
  const progress = (text: string) =>
    subject.post(target, { type: "progress", task_id: "t1", text });
  const posted = () => chat.argsOf("postThreadReply").map((args) => args[2]);

  beforeEach(async () => {
    clock = Date.UTC(2026, 0, 1);
    chat = fakeSlack();
    outbox = [];
    subject = testNotifier(outbox, { chat }, { now: () => clock });
    await progress("one");
  });

  it("posts the first message", () => {
    expect(posted()).toEqual(["one"]);
  });

  describe("a second message inside the interval", () => {
    beforeEach(async () => {
      clock += CHAT_PROGRESS_INTERVAL_MS - 1;
      await progress("two");
    });

    it("drops it", () => {
      expect(posted()).toEqual(["one"]);
    });

    describe("progress on another thread", () => {
      beforeEach(async () => {
        await subject.post(
          { source: "chat", channel: "C2", thread: "2.0" },
          { type: "progress", task_id: "t1", text: "other thread" },
        );
      });

      it("posts it, since the interval counts per thread", () => {
        expect(posted()).toEqual(["one", "other thread"]);
      });

      describe("a third message once the interval passed", () => {
        beforeEach(async () => {
          clock += 1;
          await progress("three");
        });

        it("posts it", () => {
          expect(posted()).toEqual(["one", "other thread", "three"]);
        });

        it("records every message it posted in the outbox", () => {
          expect(outbox.map((entry) => entry.payload)).toEqual([
            { text: "one" },
            { text: "other thread" },
            { text: "three" },
          ]);
        });
      });
    });
  });
});
