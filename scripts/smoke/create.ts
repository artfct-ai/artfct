/**
 * Starts a workflow from a Linear delegation and waits until its first sandbox has dialed
 * in. The later steps that need a workflow of their own start here.
 */
import { fetchConversationDebug, hasLogLine, waitUntil } from "./admin";
import { assert } from "./assert";
import { agentSessionCreated, linearDev, type LinearIssueFixture } from "./fixtures";
import { postLinearWebhook } from "./webhooks";

/** The conversation a workflow started in, and the task of its first stage. */
export type CreatedWorkflow = { conversationId: string; taskId: string };

/** Delegates `issue` on a new session and returns the workflow once its bridge said hello. */
export async function createWorkflowFromIssue(options: {
  sessionId: string;
  issue: LinearIssueFixture;
  label: string;
}): Promise<CreatedWorkflow> {
  const { sessionId, issue, label } = options;
  const reply = await postLinearWebhook(
    agentSessionCreated({ sessionId, creator: linearDev, issue }),
  );
  const conversationId = reply.conversation_id;
  assert(typeof conversationId === "string", `${label}: new issue opened a conversation`, reply);
  const task = await waitUntil({ label: `${label}: provisioned`, timeoutMs: 30_000 }, async () => {
    const debug = await fetchConversationDebug(conversationId);
    return hasLogLine(debug, "hello fresh=true") ? debug.tasks[0] : null;
  });
  return { conversationId, taskId: task.task_id };
}
