import type { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { beforeEach, describe, expect, it } from "bun:test";
import { fakeSlack, testNotifier } from "../../test/notifier-fixture";
import type { Notifier, OutboxEntry } from "./notifier";

const thread = { source: "chat", channel: "C1", thread: "1.0" } as const;

describe("Notifier boards", () => {
  let outbox: OutboxEntry[];

  beforeEach(() => {
    outbox = [];
  });

  describe("a Slack board", () => {
    let chat: FakeChat;
    let subject: Notifier;
    let messageId: string;

    beforeEach(async () => {
      chat = fakeSlack();
      subject = testNotifier(outbox, { chat });
      messageId = await subject.createBoard(thread, "x".repeat(5000));
    });

    it("answers the ts of the thread message", () => {
      expect(messageId).toBe("1700000001.000100");
    });

    describe("edited afterwards", () => {
      beforeEach(async () => {
        await subject.editBoard(thread, messageId, "edited");
      });

      it("posts one message and updates it", () => {
        expect(chat.calls.map((call) => call.method)).toEqual([
          "postThreadMessage",
          "updateMessage",
        ]);
      });

      it("edits the message by its ts", () => {
        expect(chat.argsOf("updateMessage")).toEqual([["C1", "1700000001.000100", "edited"]]);
      });

      it("records the create and the edit in the outbox", () => {
        expect(outbox.map((entry) => [entry.channel, entry.kind])).toEqual([
          ["board", "create"],
          ["board", "edit"],
        ]);
      });
    });
  });

  describe("a Linear board", () => {
    const issue = { source: "tracker", issue_id: "issue-1" } as const;
    let tracker: FakeTracker;
    let messageId: string;

    beforeEach(async () => {
      tracker = new FakeTracker({ commentId: "comment-7" });
      const subject = testNotifier(outbox, { tracker });
      messageId = await subject.createBoard(issue, "todo");
      await subject.editBoard(issue, messageId, "todo 2");
    });

    it("answers the comment id", () => {
      expect(messageId).toBe("comment-7");
    });

    it("comments on the issue and edits that comment by id", () => {
      expect(tracker.calls).toEqual([
        { method: "commentOnIssue", args: ["issue-1", "todo"] },
        { method: "updateComment", args: ["comment-7", "todo 2"] },
      ]);
    });
  });

  describe("a Slack board moved to the end of the thread", () => {
    let chat: FakeChat;
    let permalink: string;

    beforeEach(async () => {
      chat = fakeSlack();
      const subject = testNotifier(outbox, { chat });
      permalink = await subject.boardPermalink(thread, "1.5");
      await subject.deleteBoard(thread, "1.1");
    });

    it("links the new message", () => {
      expect(permalink).toBe("https://chat.test/C1/1.5");
    });

    it("deletes the previous message by its ts", () => {
      expect(chat.argsOf("deleteMessage")).toEqual([["C1", "1.1"]]);
    });

    it("records the delete in the outbox", () => {
      expect(outbox.map((entry) => [entry.channel, entry.kind])).toEqual([["board", "delete"]]);
    });
  });

  describe("a Linear board moved to the end of the issue", () => {
    const issue = { source: "tracker", issue_id: "issue-1" } as const;
    let tracker: FakeTracker;
    let permalink: string;

    beforeEach(async () => {
      tracker = new FakeTracker();
      const subject = testNotifier(outbox, { tracker });
      permalink = await subject.boardPermalink(issue, "comment-8");
      await subject.deleteBoard(issue, "comment-7");
    });

    it("links the new comment", () => {
      expect(permalink).toBe("https://tracker.test/comment/comment-8");
    });

    it("deletes the previous comment by id", () => {
      expect(tracker.argsOf("deleteComment")).toEqual([["comment-7"]]);
    });
  });

  describe("without a client", () => {
    it("answers a local id", async () => {
      expect(await testNotifier(outbox).createBoard(thread, "todo")).toBe("local:chat");
    });

    it("records a delete in the outbox alone", async () => {
      await testNotifier(outbox).deleteBoard(thread, "local:chat");
      expect(outbox.map((entry) => entry.kind)).toEqual(["delete"]);
    });

    it("has no link to give", async () => {
      await expect(testNotifier(outbox).boardPermalink(thread, "local:chat")).rejects.toThrow(
        "no chat client",
      );
    });
  });

  describe("when the Slack edit fails", () => {
    it("lets the API error through, since the board owns the retry", async () => {
      await expect(
        testNotifier(outbox, { chat: fakeSlack(["updateMessage"]) }).editBoard(thread, "1.1", "x"),
      ).rejects.toThrow("slack updateMessage: msg_too_long");
    });
  });
});
