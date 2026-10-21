import type { Chat } from "@artfct-ai/adapters/chat/types";
import type { WorkflowDefinition, WorkflowTrigger } from "../config/workflow-definition";
import type { Database } from "../db/client";
import { conversationIdOf, recordConversation } from "../db/conversations";
import { keepFiringThread, recordedFiringThread, type FiringThread } from "../db/firing-threads";
import { firingKey } from "./firing-key";
import { failureLineText, startLineText } from "./start-line";
import type { ConversationFiring, FiringAnswer, TriggerFiring } from "./types";

/** The wait before each retry of a failed attempt, in seconds: after the first and after the second. */
const RETRY_DELAYS_SECONDS = [30, 120] as const;

/** What the firing queue's consumer works with. */
export type FiringConsumer = {
  db: Database;
  /** The chat the start line and the failure line go to. Null without a credential. */
  chat: Chat | null;
  definitions: readonly WorkflowDefinition[];
  /** Hand a firing to the conversation of its start line's thread. */
  fire: (conversationId: string, firing: ConversationFiring) => Promise<FiringAnswer>;
  /** Send the firing's next attempt to the queue, delivered after the delay. */
  sendAttempt: (firing: TriggerFiring, delaySeconds: number) => Promise<void>;
};

/** How one attempt ended: the conversation took the firing, or the attempt failed. */
type AttemptOutcome =
  | { kind: "taken" }
  | { kind: "failed"; thread: FiringThread | null; reason: string };

/**
 * Take one attempt of a firing. A failed attempt sends the next one after its delay. After the
 * last attempt fails, the error is logged and the firing's thread gets the failure line.
 */
export async function consumeFiring(
  consumer: FiringConsumer,
  firing: TriggerFiring,
): Promise<void> {
  const trigger = triggerOf(consumer.definitions, firing);
  if (!trigger) {
    console.error(`firing ${firingKey(firing)} names a trigger the deployment does not hold`);
    return;
  }
  const outcome = await attemptFiring(consumer, firing, trigger);
  if (outcome.kind === "taken") return;
  const delay = RETRY_DELAYS_SECONDS[firing.attempt - 1];
  if (delay !== undefined) {
    await consumer.sendAttempt({ ...firing, attempt: firing.attempt + 1 }, delay);
    return;
  }
  console.error(`firing ${firingKey(firing)} failed its last attempt: ${outcome.reason}`);
  if (outcome.thread) await postFailureLine(consumer, firing, outcome.thread);
}

/** The trigger a firing names, by its definition and its position. Null after a deploy removed it. */
function triggerOf(
  definitions: readonly WorkflowDefinition[],
  firing: TriggerFiring,
): WorkflowTrigger | null {
  const definition = definitions.find((declared) => declared.name === firing.definition);
  return definition?.triggers[firing.position] ?? null;
}

/** Find or post the start line, record its thread's conversation, and hand the firing to it. */
async function attemptFiring(
  consumer: FiringConsumer,
  firing: TriggerFiring,
  trigger: WorkflowTrigger,
): Promise<AttemptOutcome> {
  let thread: FiringThread | null = null;
  try {
    thread = await firingThread(consumer, firing, trigger);
    const place = { source: "chat_thread", ...thread } as const;
    await recordConversation(consumer.db, place);
    const conversationId = await conversationIdOf(place);
    const answer = await consumer.fire(conversationId, { firing, trigger, thread: thread.thread });
    if (answer.kind !== "active_workflow") return { kind: "taken" };
    return { kind: "failed", thread, reason: `workflow ${answer.workflow_id} is active` };
  } catch (error) {
    return { kind: "failed", thread, reason: String(error).slice(0, 300) };
  }
}

/**
 * The firing's recorded start line. Without a record, post the start line, record it unless a
 * racing attempt recorded one first, and use the recorded one.
 */
async function firingThread(
  consumer: FiringConsumer,
  firing: TriggerFiring,
  trigger: WorkflowTrigger,
): Promise<FiringThread> {
  const recorded = await recordedFiringThread(consumer.db, firing);
  if (recorded) return recorded;
  if (!consumer.chat) throw new Error("the chat has no credential, so the start line cannot post");
  const posted = await consumer.chat.postChannelMessage(
    trigger.channel,
    startLineText(firing.definition),
  );
  return keepFiringThread(consumer.db, firing, { channel: trigger.channel, thread: posted.ts });
}

/** Tell the firing's thread that its workflow could not start. A failed post is only logged. */
async function postFailureLine(
  consumer: FiringConsumer,
  firing: TriggerFiring,
  thread: FiringThread,
): Promise<void> {
  try {
    await consumer.chat?.postThreadReply(
      thread.channel,
      thread.thread,
      failureLineText(firing.definition),
    );
  } catch (error) {
    console.warn(`the failure line of ${firingKey(firing)} did not post: ${String(error)}`);
  }
}
