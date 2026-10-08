import type { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
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
