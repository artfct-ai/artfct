import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { replyTargetKey } from "../workflow/store/reply-target-key";
import type { TaskEvent } from "../workflow/task/events";

/**
 * Who hears one orchestrator post. `reply_to` answers the event of one person where they wrote.
 * `answering` reaches the workflow's audience and answers the people who wrote from these targets.
 */
export type Recipients = { reply_to: ReplyTarget } | { answering: ReplyTarget[] };

/** What decides who hears a post: where the workflow started, and every place it replies to. */
export type Audience = { origin: ReplyTarget | null; replyTargets: ReplyTarget[] };

/** True when a chat thread is among the reply targets. Orchestrator conversation then stays there. */
export function hasChatThread(replyTargets: ReplyTarget[]): boolean {
  return replyTargets.some((target) => target.source === "chat");
}

/** True for an event that asks a person to act or tells them work failed. */
function isAskOrFailure(event: TaskEvent): boolean {
  switch (event.type) {
    case "question":
    case "artifact_ready":
    case "failed":
    case "workflow_failed":
    case "turn_failed":
      return true;
    default:
      return false;
  }
}

/**
 * The reply targets one post goes to. A tracker session hears the orchestrator only in a
 * workflow without a chat thread: the starting session gets its asks and failure notices, and a
 * session a person wrote in gets the answer. With a chat thread, an answer to a session goes to
 * the chat threads.
 */
export function recipientsOf(
  audience: Audience,
  event: TaskEvent,
  recipients: Recipients,
): ReplyTarget[] {
  const chatThreads = audience.replyTargets.filter((target) => target.source === "chat");
  if ("reply_to" in recipients) {
    const target = recipients.reply_to;
    if (target.source !== "tracker" || chatThreads.length === 0) return [target];
    return chatThreads;
  }
  const outsideSessions = audience.replyTargets.filter((target) => target.source !== "tracker");
  if (chatThreads.length > 0) return outsideSessions;
  const { origin } = audience;
  const startingSession = origin?.source === "tracker" && isAskOrFailure(event) ? [origin] : [];
  const answered = recipients.answering.filter((target) => target.source === "tracker");
  return uniqueTargets([...outsideSessions, ...startingSession, ...answered]);
}

function uniqueTargets(targets: ReplyTarget[]): ReplyTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = replyTargetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
