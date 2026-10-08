import type { Chat } from "@artfct-ai/adapters/chat/types";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";

/** How long a chat message may wait for its workflow before it gets the eyes reaction. */
export const CHAT_ACK_DELAY_MS = 3_000;

const EYES = "eyes";

/**
 * Deliver a chat message to its workflow. The workflow puts the thread in its working status as
 * it takes the message. When that takes longer than the delay, the message gets the eyes reaction
 * until the delivery returns. A reaction call that fails is logged and never fails the delivery.
 */
export async function deliverWithChatAck<Result>(
  chat: Chat | null,
  event: InboundEvent,
  deliver: () => Promise<Result>,
  delayMs: number = CHAT_ACK_DELAY_MS,
): Promise<Result> {
  const target = event.reply_to;
  const message = event.acknowledge?.message;
  if (!chat || !message || target?.source !== "chat") return deliver();
  const eyes: { added: Promise<boolean> | null } = { added: null };
  const timer = setTimeout(() => {
    eyes.added = chat.addReaction(target.channel, message, EYES).then(
      () => true,
      (error: unknown) => {
        console.warn(`chat eyes reaction failed: ${String(error)}`);
        return false;
      },
    );
  }, delayMs);
  try {
    return await deliver();
  } finally {
    clearTimeout(timer);
    if (eyes.added && (await eyes.added)) {
      await chat.removeReaction(target.channel, message, EYES).catch((error: unknown) => {
        console.warn(`chat eyes removal failed: ${String(error)}`);
      });
    }
  }
}
