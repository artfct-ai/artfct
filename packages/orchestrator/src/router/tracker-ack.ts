import type { AgentActivityContent, Tracker } from "@artfct-ai/adapters/tracker/types";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";

/** The first thing a session someone opened hears, before the workflow reads anything. */
export const ON_IT = "On it. Reading the issue.";

/** Posted on a session nobody opened when no workflow is working on its issue. */
export const NOTHING_TO_JOIN =
  "No workflow is working on this issue. Delegate it to me or mention me to start one.";

/** The agent session a tracker start event opened. Null for every other event. */
export function trackerSessionId(event: InboundEvent): string | null {
  if (event.kind !== "start") return null;
  return event.reply_to?.source === "tracker" ? event.reply_to.session_id : null;
}

/** The note posted when the session joins a workflow that already exists for its issue. */
export function joinedNote(workflowId: string): string {
  return `Continuing the existing workflow ${workflowId} for this issue.`;
}

/** Post one activity on a session. A failed post is logged and swallowed. */
export async function postTrackerAck(
  tracker: Tracker | null,
  sessionId: string,
  content: AgentActivityContent,
): Promise<void> {
  if (!tracker) return;
  try {
    await tracker.activity(sessionId, content);
  } catch (error) {
    console.warn(`tracker ack on session ${sessionId} failed: ${String(error)}`);
  }
}
