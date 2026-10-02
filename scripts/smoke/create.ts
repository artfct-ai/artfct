/**
 * Starts a workflow from a Linear delegation and waits until its first sandbox has dialed
 * in. The later steps that need a workflow of their own start here.
 */
import { fetchWorkflowDebug, hasLogLine, waitUntil } from "./admin";
import { assertEqual } from "./assert";
import { agentSessionCreated, linearDev, type LinearIssueFixture } from "./fixtures";
import { postLinearWebhook } from "./webhooks";

/** A workflow and the task of its first stage. */
export type CreatedWorkflow = { workflowId: string; taskId: string };

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
  assertEqual(reply.created, true, `${label}: new issue created a new workflow`);
  const workflowId = reply.workflow_id as string;
  const task = await waitUntil({ label: `${label}: provisioned`, timeoutMs: 30_000 }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return hasLogLine(debug, "hello fresh=true") ? debug.tasks[0] : null;
  });
  return { workflowId, taskId: task.task_id };
}
