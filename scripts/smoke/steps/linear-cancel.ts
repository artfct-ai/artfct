/**
 * Step 6. A new workflow's issue moves to Canceled in Linear. The workflow ends, its task is
 * cancelled, the sandbox is destroyed, and the Linear session does not hear about it.
 */
import { fetchWorkflowDebug, hasOutboxMessage, outboxText, taskById, waitUntil } from "../admin";
import { assert } from "../assert";
import { PAGE_PARENT_ID, REPO_FULL_NAME } from "../config";
import { createWorkflowFromIssue } from "../create";
import {
  issueStateChanged,
  LINEAR_CANCELED_STATE,
  LINEAR_TEAM_STATES,
  linearDev,
  linearIssue,
  linearSessionId,
} from "../fixtures";
import { assertStartsSince, startCountBaseline, waitForSandboxDestroyed } from "../sandbox";
import { postLinearWebhook } from "../webhooks";

/**
 * The session and issue of the workflow this step cancels. Its author never finishes the turn,
 * so no reviewer sandbox starts while the cancel tears the workflow down.
 */
const CANCEL_SESSION = linearSessionId(2);
const CANCEL_ISSUE = linearIssue(
  2,
  "ENG-43",
  "Add a changelog",
  `Keep a changelog. Never finish this. Repo: https://github.com/${REPO_FULL_NAME}\nPage parent: ${PAGE_PARENT_ID}`,
);

/** Runs step 6 on a workflow of its own. */
export async function runLinearCancel(): Promise<void> {
  console.log("\n6. Linear issue canceled");
  const { workflowId, taskId } = await createWorkflowFromIssue({
    sessionId: CANCEL_SESSION,
    issue: CANCEL_ISSUE,
    label: "second workflow",
  });
  const startsBefore = await startCountBaseline(taskId);
  const startedState = LINEAR_TEAM_STATES.find((state) => state.type === "started")!;

  const reply = await postLinearWebhook(
    issueStateChanged({
      issue: CANCEL_ISSUE,
      from: startedState,
      to: LINEAR_CANCELED_STATE,
      actor: linearDev,
    }),
    "Issue",
  );
  assert(!("ignored" in reply), "the issue move was delivered as an event", reply);

  const cancelled = await waitUntil({ label: "workflow cancelled from the issue" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const done =
      debug.state.status === "cancelled" && taskById(debug, taskId).status === "cancelled";
    return done ? debug : null;
  });
  assert(
    !hasOutboxMessage(
      cancelled,
      (message) => message.channel === "tracker" && outboxText(message).startsWith("Cancelled."),
    ),
    "the cancellation stays out of the Linear session",
    cancelled.outbox,
  );
  const exit = await waitForSandboxDestroyed(taskId, "/destroy reached the mock sandbox");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
  await assertStartsSince(startsBefore, 0, "no restart after the cancel", taskId);
}
