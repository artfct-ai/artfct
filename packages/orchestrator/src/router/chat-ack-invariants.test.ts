import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  CHAT_ACK_INVARIANTS,
  type ChatAckOutcome,
  type ChatAckRecord,
  type ObservedReaction,
} from "../../test/chat-ack-invariants";
import { deliverWithChatAck } from "./chat-ack";

type Answer = "accepts" | "refuses";

type ScriptedMessage = {
  source: "chat" | "tracker";
  speed: "prompt" | "slow";
  delivery: "returns" | "throws";
  add: Answer;
  remove: Answer;
};

const DELAY_MS = 2;
const SLOW_DELIVERY_MS = 20;

class ReactionChat extends FakeChat {
  readonly seen = new Map<string, ObservedReaction[]>();

  constructor(private readonly scripts: Map<string, ScriptedMessage>) {
    super();
  }

  override async addReaction(_channel: string, ts: string): Promise<void> {
    this.react(ts, "addReaction", this.scripts.get(ts)?.add ?? "refuses");
  }

  override async removeReaction(_channel: string, ts: string): Promise<void> {
    this.react(ts, "removeReaction", this.scripts.get(ts)?.remove ?? "refuses");
  }

  private react(ts: string, method: ObservedReaction["method"], answer: Answer): void {
    const accepted = answer === "accepts";
    this.seen.set(ts, [...(this.seen.get(ts) ?? []), { method, accepted }]);
    if (!accepted) throw new Error(`${method} refused`);
  }
}

const scriptedMessage: fc.Arbitrary<ScriptedMessage> = fc.record({
  source: fc.constantFrom("chat", "chat", "tracker"),
  speed: fc.constantFrom("prompt", "slow"),
  delivery: fc.constantFrom("returns", "throws"),
  add: fc.constantFrom("accepts", "accepts", "refuses"),
  remove: fc.constantFrom("accepts", "accepts", "refuses"),
});

function eventFor(message: ScriptedMessage, ts: string): InboundEvent {
  const base: InboundEvent = {
    id: `evt-${ts}`,
    kind: "prompt",
    actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
    bindings: [],
    links: [],
    text: "also add a test",
    reply_to: { source: "chat", channel: "C1", thread: "1.0" },
    acknowledge: { message: ts, user: "U1" },
  };
  if (message.source === "chat") return base;
  return {
    ...base,
    reply_to: { source: "tracker", session_id: "s1", issue_id: "i1" },
    acknowledge: undefined,
  };
}

async function delivery(message: ScriptedMessage, ts: string): Promise<string> {
  if (message.speed === "slow")
    await new Promise((resolve) => setTimeout(resolve, SLOW_DELIVERY_MS));
  else await Promise.resolve();
  if (message.delivery === "throws") throw new Error(`workflow unavailable for ${ts}`);
  return `delivered ${ts}`;
}

function outcomeOf(settled: PromiseSettledResult<string>): ChatAckOutcome {
  if (settled.status === "fulfilled") return { kind: "returned", value: settled.value };
  return { kind: "threw", message: String(settled.reason) };
}

async function deliverConcurrently(messages: ScriptedMessage[]): Promise<ChatAckRecord[]> {
  const stamps = messages.map((_message, index) => `2.${index}`);
  const chat = new ReactionChat(
    new Map(messages.map((message, index) => [stamps[index]!, message])),
  );
  const delivered = messages.map((message, index) => delivery(message, stamps[index]!));
  const returned = await Promise.allSettled(
    messages.map((message, index) =>
      deliverWithChatAck(
        chat,
        eventFor(message, stamps[index]!),
        () => delivered[index]!,
        DELAY_MS,
      ),
    ),
  );
  const settled = await Promise.allSettled(delivered);
  return messages.map((message, index) => ({
    fromChat: message.source === "chat",
    slow: message.speed === "slow",
    reactions: chat.seen.get(stamps[index]!) ?? [],
    delivered: outcomeOf(settled[index]!),
    returned: outcomeOf(returned[index]!),
  }));
}

describe("chat acknowledgement invariants", () => {
  it("hold for concurrent messages on one thread", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(scriptedMessage, { minLength: 1, maxLength: 3 }),
        async (messages) => {
          const records = await deliverConcurrently(messages);
          for (const record of records) {
            for (const invariant of CHAT_ACK_INVARIANTS) invariant(record);
          }
          expect(records).toHaveLength(messages.length);
        },
      ),
      { numRuns: 60 },
    );
  });
});
