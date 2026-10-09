import type {
  ActivityOptions,
  AgentActivityContent,
  Tracker,
} from "@artfct-ai/adapters/tracker/types";

/** The ephemeral thought a session gets before a workflow reads anything. */
export const ON_IT = "On it. Reading the issue.";

/** Posted on a session nobody opened when no workflow is working on its issue. */
export const NOTHING_TO_JOIN =
  "No workflow is working on this issue. Delegate it to me or mention me to start one.";

/** Post the starting thought on a session. */
export function postStartingThought(tracker: Tracker | null, sessionId: string): Promise<void> {
  return postTrackerAck(tracker, sessionId, { type: "thought", body: ON_IT }, { ephemeral: true });
}

/** Post one activity on a session. A failed post is logged and swallowed. */
export async function postTrackerAck(
  tracker: Tracker | null,
  sessionId: string,
  content: AgentActivityContent,
  options: ActivityOptions = {},
): Promise<void> {
  if (!tracker) return;
  try {
    await tracker.activity(sessionId, content, options);
  } catch (error) {
    console.warn(`tracker ack on session ${sessionId} failed: ${String(error)}`);
  }
}
