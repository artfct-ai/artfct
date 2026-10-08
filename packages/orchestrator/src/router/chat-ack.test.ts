import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { deliverWithChatAck } from "./chat-ack";

const SLACK_PROMPT: InboundEvent = {
  id: "evt-1",
  kind: "prompt",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "also add a test",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
  acknowledge: { message: "1.5", user: "U1" },
};

const SHORT_DELAY_MS = 1;
const LONG_DELAY_MS = 1_000;

function after(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve("delivered"), ms));
}

async function failing(): Promise<string> {
  await after(20);
  throw new Error("workflow unavailable");
}

describe("deliverWithChatAck", () => {
  describe("a workflow that takes the message within the delay", () => {
    const chat = new FakeChat();
    const delivered = deliverWithChatAck(chat, SLACK_PROMPT, () => after(0), LONG_DELAY_MS);

    it("returns the delivery", async () => {
      expect(await delivered).toBe("delivered");
    });

    it("leaves the message without the eyes reaction", async () => {
      await delivered;
      expect(chat.calls).toEqual([]);
    });
  });

  describe("a workflow that takes the message after the delay", () => {
    const chat = new FakeChat();
    const delivered = deliverWithChatAck(chat, SLACK_PROMPT, () => after(20), SHORT_DELAY_MS);

    it("returns the delivery", async () => {
      expect(await delivered).toBe("delivered");
    });

    it("adds the eyes reaction while it waits and removes it once the workflow took the message", async () => {
      await delivered;
      expect(chat.calls.map((call) => [call.method, ...call.args])).toEqual([
        ["addReaction", "C1", "1.5", "eyes"],
        ["removeReaction", "C1", "1.5", "eyes"],
      ]);
    });
  });

  describe("a delivery that fails after the delay", () => {
    const chat = new FakeChat();
    const delivered = deliverWithChatAck(chat, SLACK_PROMPT, failing, SHORT_DELAY_MS);
    delivered.catch(() => {});

    it("rejects the way the delivery did", async () => {
      await expect(delivered).rejects.toThrow("workflow unavailable");
    });

    it("still removes the eyes reaction", async () => {
      await delivered.catch(() => {});
      expect(chat.calls.map((call) => call.method)).toEqual(["addReaction", "removeReaction"]);
    });
  });

  describe("a chat that refuses every reaction", () => {
    const chat = new FakeChat({ failing: true });
    const delivered = deliverWithChatAck(chat, SLACK_PROMPT, () => after(20), SHORT_DELAY_MS);

    it("returns the delivery", async () => {
      expect(await delivered).toBe("delivered");
    });

    it("does not try to remove a reaction it never added", async () => {
      await delivered;
      expect(chat.calls.map((call) => call.method)).toEqual(["addReaction"]);
    });
  });

  describe("an event from the tracker", () => {
    const chat = new FakeChat();
    const fromTracker: InboundEvent = {
      ...SLACK_PROMPT,
      reply_to: { source: "tracker", session_id: "s1", issue_id: "i1" },
      acknowledge: undefined,
    };
    const delivered = deliverWithChatAck(chat, fromTracker, () => after(20), SHORT_DELAY_MS);

    it("never reacts in chat", async () => {
      await delivered;
      expect(chat.calls).toEqual([]);
    });
  });
});
