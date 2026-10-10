import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskEvent } from "../workflow/task/events";

/**
 * Who hears one orchestrator post. `reply_to` answers the event of one person where they wrote.
 * `answering` reaches the workflow's audience and answers the people who wrote from these targets.
 */
export type Recipients = { reply_to: ReplyTarget } | { answering: ReplyTarget[] };

/** The recipients of a post of the running turn: the audience, and the people the turn answers. */
export function turnRecipients(turn: { answering(): ReplyTarget[] }): Recipients {
  return { answering: turn.answering() };
}

/** The part of the workflow state that decides who hears a post. */
export type Audience = { origin: ReplyTarget | null; reply_targets: ReplyTarget[] };

/** True when a chat thread is among the reply targets. Orchestrator conversation then stays there. */
export function hasChatThread(audience: Audience): boolean {
  return audience.reply_targets.some((target) => target.source === "chat");
}

/** True for an event that asks a person to act or tells them work failed. */
export function isAskOrFailure(event: TaskEvent): boolean {
  switch (event.type) {
    case "question":
    case "artifact_ready":
    case "failed":
    case "workflow_failed":
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
  const chatThreads = audience.reply_targets.filter((target) => target.source === "chat");
  if ("reply_to" in recipients) {
    const target = recipients.reply_to;
    if (target.source !== "tracker" || chatThreads.length === 0) return [target];
    return chatThreads;
  }
  const outsideSessions = audience.reply_targets.filter((target) => target.source !== "tracker");
  if (chatThreads.length > 0) return outsideSessions;
  const { origin } = audience;
  const startingSession = origin?.source === "tracker" && isAskOrFailure(event) ? [origin] : [];
  const answered = recipients.answering.filter((target) => target.source === "tracker");
  return uniqueTargets([...outsideSessions, ...startingSession, ...answered]);
}

function uniqueTargets(targets: ReplyTarget[]): ReplyTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key =
      target.source === "tracker" ? `tracker:${target.session_id}` : JSON.stringify(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
