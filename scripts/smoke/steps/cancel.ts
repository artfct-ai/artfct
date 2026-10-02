/** Step 8. A fresh workflow is provisioned then cancelled from Linear: one start, one destroy. */
import { fetchWorkflowDebug, hasOutboxMessage, outboxText, waitUntil } from "../admin";
import { assert } from "../assert";
import { PAGE_PARENT_ID, REPO_FULL_NAME } from "../config";
import { createWorkflowFromIssue } from "../create";
import { agentSessionPrompted, linearDev, linearIssue, linearSessionId } from "../fixtures";
import { assertStartsSince, waitForSandboxDestroyed } from "../sandbox";
import { postLinearWebhook } from "../webhooks";

const THIRD_SESSION = linearSessionId(3);
const SECOND_ISSUE = linearIssue(
  2,
  "ENG-43",
  "Add dark mode",
  `Make it dark. Repo: https://github.com/${REPO_FULL_NAME}\nPage parent: ${PAGE_PARENT_ID}`,
);

/** Sends `cancel` on the session and waits for the workflow and task to be cancelled. */
async function cancelWorkflow(workflowId: string): Promise<void> {
  await postLinearWebhook(
    agentSessionPrompted({
      sessionId: THIRD_SESSION,
      creator: linearDev,
      issue: SECOND_ISSUE,
      body: "cancel",
    }),
  );
  const cancelled = await waitUntil({ label: "second workflow cancelled" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const isCancelled =
      debug.state.status === "cancelled" && debug.tasks[0]?.status === "cancelled";
    return isCancelled ? debug : null;
  });
  assert(
    hasOutboxMessage(
      cancelled,
      (message) =>
        message.channel === "tracker" &&
        message.kind === "response" &&
        outboxText(message).startsWith("Cancelled."),
    ),
    "cancellation posted to Linear",
    cancelled.outbox,
  );
}

/** Runs step 8. */
export async function runCancel(): Promise<void> {
  console.log("\n8. Cancel");
  const { workflowId, taskId } = await createWorkflowFromIssue({
    sessionId: THIRD_SESSION,
    issue: SECOND_ISSUE,
    label: "second workflow",
  });
  await assertStartsSince(0, 1, "mock sandbox saw one start for the second workflow", taskId);

  await cancelWorkflow(workflowId);
  const exit = await waitForSandboxDestroyed(taskId, "/destroy reached the mock sandbox");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
  await assertStartsSince(0, 1, "no restart after the cancel", taskId);
}
