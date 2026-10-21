import type { Chat } from "@artfct-ai/adapters/chat/types";
import type { CodeHost } from "@artfct-ai/adapters/code/types";
import type { WorkflowDefinition, WorkflowTrigger } from "../config/workflow-definition";
import type { Database } from "../db/client";
import { conversationIdOf, recordConversation } from "../db/conversations";
import { keepFiringThread, recordedFiringThread } from "../db/firing-threads";
import { firingKey } from "./firing-key";
import { failureLineText, startLineText } from "./start-line";
import type { ConversationFiring, FiringAnswer, FiringOrigin, TriggerFiring } from "./types";

/** The wait before each retry of a failed attempt, in seconds: after the first and after the second. */
const RETRY_DELAYS_SECONDS = [30, 120] as const;

/** What the firing queue's consumer works with. */
export type FiringConsumer = {
  db: Database;
  /** The chat the start line and the failure line go to. Null without a credential. */
  chat: Chat | null;
  /** The code host a pull request firing's failure line goes to. Null without a credential. */
  code: CodeHost | null;
  definitions: readonly WorkflowDefinition[];
  /** Hand a firing to its conversation. */
  fire: (conversationId: string, firing: ConversationFiring) => Promise<FiringAnswer>;
  /** Send the firing's next attempt to the queue, delivered after the delay. */
  sendAttempt: (firing: TriggerFiring, delaySeconds: number) => Promise<void>;
};

/** How one attempt ended: the conversation took the firing, or the attempt failed. */
type AttemptOutcome =
  | { kind: "taken" }
  | { kind: "failed"; origin: FiringOrigin | null; reason: string };

/**
 * Take one attempt of a firing. A failed attempt sends the next one after its delay. After the
 * last attempt fails, the error is logged and the firing's thread or pull request gets the failure
 * line.
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
  if (outcome.origin) await postFailureLine(consumer, firing, outcome.origin);
}

/** The trigger a firing names, by its definition and its position. Null after a deploy removed it. */
function triggerOf(
  definitions: readonly WorkflowDefinition[],
  firing: TriggerFiring,
): WorkflowTrigger | null {
  const definition = definitions.find((declared) => declared.name === firing.definition);
  return definition?.triggers[firing.position] ?? null;
}

/** Find the firing's conversation and where it replies, and hand the firing to it. */
async function attemptFiring(
  consumer: FiringConsumer,
  firing: TriggerFiring,
  trigger: WorkflowTrigger,
): Promise<AttemptOutcome> {
  let origin: FiringOrigin | null = null;
  try {
    const place = await firingPlace(consumer, firing);
    origin = place.origin;
    const answer = await consumer.fire(place.conversationId, { firing, trigger, origin });
    switch (answer.kind) {
      case "started":
      case "prompted":
      case "duplicate":
        return { kind: "taken" };
      case "ending":
        return { kind: "failed", origin, reason: `workflow ${answer.workflow_id} is ending` };
      case "active_workflow":
        return { kind: "failed", origin, reason: `workflow ${answer.workflow_id} is active` };
      default: {
        const unreachable: never = answer;
        throw new Error(`unhandled firing answer ${String(unreachable)}`);
      }
    }
  } catch (error) {
    return { kind: "failed", origin, reason: String(error).slice(0, 300) };
  }
}

/** A firing's conversation and where its workflow replies. */
type FiringPlace = { conversationId: string; origin: FiringOrigin };

/**
 * The conversation a firing lands in. A channel firing's is its start line's thread, recorded so
 * replies in the thread reach it. A pull request firing's is the pull request's with the firing's
 * definition, and it replies on the pull request.
 */
async function firingPlace(consumer: FiringConsumer, firing: TriggerFiring): Promise<FiringPlace> {
  const { reports } = firing;
  switch (reports.kind) {
    case "channel": {
      const thread = await firingThread(consumer, firing, reports.channel);
      const place = { source: "chat_thread", ...thread } as const;
      await recordConversation(consumer.db, place);
      const conversationId = await conversationIdOf(place);
      return { conversationId, origin: { source: "chat", ...thread } };
    }
    case "pull_request": {
      const { repo, number } = reports;
      const place = {
        source: "pull_request",
        repo,
        number,
        definition: firing.definition,
      } as const;
      const conversationId = await conversationIdOf(place);
      return { conversationId, origin: { source: "code", repo, pull: number } };
    }
    default: {
      const unreachable: never = reports;
      throw new Error(`unhandled firing report ${String(unreachable)}`);
    }
  }
}

/**
 * The firing's recorded start line. Without a record, post the start line, record it unless a
 * racing attempt recorded one first, and use the recorded one.
 */
async function firingThread(
  consumer: FiringConsumer,
  firing: TriggerFiring,
  channel: string,
): Promise<{ channel: string; thread: string }> {
  const recorded = await recordedFiringThread(consumer.db, firing);
  if (recorded) return recorded;
  if (!consumer.chat) throw new Error("the chat has no credential, so the start line cannot post");
  const posted = await consumer.chat.postChannelMessage(channel, startLineText(firing.definition));
  return keepFiringThread(consumer.db, firing, { channel, thread: posted.ts });
}

/**
 * Tell the firing's thread, or its pull request, that its workflow could not start. A failed post
 * is only logged.
 */
async function postFailureLine(
  consumer: FiringConsumer,
  firing: TriggerFiring,
  origin: FiringOrigin,
): Promise<void> {
  const text = failureLineText(firing.definition);
  try {
    if (origin.source === "chat") {
      await consumer.chat?.postThreadReply(origin.channel, origin.thread, text);
    } else {
      await consumer.code?.commentOnPull(origin.repo, origin.pull, text);
    }
  } catch (error) {
    console.warn(`the failure line of ${firingKey(firing)} did not post: ${String(error)}`);
  }
}
