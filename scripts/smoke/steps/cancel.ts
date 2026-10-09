/**
 * Step 8. A fresh workflow is provisioned and its author's first turn never finishes. A message
 * in its job session goes straight to the running author, and the Stop button ends that turn
 * while the workflow runs on. Moving the issue to Canceled then cancels the workflow: one start,
 * one destroy.
 */
import {
  countLogLines,
  countSessionPosts,
  countTaskLogLines,
  fetchWorkflowDebug,
  hasLogLine,
  taskById,
  waitUntil,
  type WorkflowDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { PAGE_PARENT_ID, REPO_FULL_NAME } from "../config";
import { createWorkflowFromIssue } from "../create";
import {
  agentSessionPrompted,
  issueStateChanged,
  LINEAR_CANCELED_STATE,
  LINEAR_TEAM_STATES,
  linearDev,
  linearIssue,
  linearSessionId,
} from "../fixtures";
import { assertStartsSince, waitForSandboxDestroyed } from "../sandbox";
import { postLinearWebhook } from "../webhooks";

const THIRD_SESSION = linearSessionId(3);
const SECOND_ISSUE = linearIssue(
  2,
  "ENG-43",
  "Add dark mode",
  `Make it dark. Never finish this. Repo: https://github.com/${REPO_FULL_NAME}\nPage parent: ${PAGE_PARENT_ID}`,
);
/** Writes `body` on the job session, as a plain message or with the Stop button. */
function writeInSession(body: string, signal?: "stop") {
  return postLinearWebhook(
    agentSessionPrompted({
      sessionId: THIRD_SESSION,
      creator: linearDev,
      issue: SECOND_ISSUE,
      body,
      signal,
    }),
  );
}

/** A message in the job session reaches the running author without a turn or a post. */
async function forwardToAuthor(workflowId: string, taskId: string): Promise<WorkflowDebug> {
  const before = await waitUntil({ label: "the author's first turn runs" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return countTaskLogLines(debug, taskId, "permission:") > 0 ? debug : null;
  });
  const agentTurns = countLogLines(before, "agent turn started");
  await writeInSession("Rename the helper. Never finish this either.");
  const forwarded = await waitUntil({ label: "the message reached the author" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return hasLogLine(debug, "a reply in its job session reached the author") ? debug : null;
  });
  assertEqual(
    countLogLines(forwarded, "agent turn started"),
    agentTurns,
    "the message started no orchestrator turn",
  );
  assertEqual(countSessionPosts(forwarded), countSessionPosts(before), "nothing posted on it");
  return forwarded;
}

/** The Stop button cancels the author's prompt turn and leaves the task and workflow running. */
async function pressStop(workflowId: string, taskId: string): Promise<void> {
  const before = await forwardToAuthor(workflowId, taskId);
  const status = taskById(before, taskId).status;
  await writeInSession("Stop", "stop");
  const stopped = await waitUntil({ label: "the author's turn ended on the stop" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return countTaskLogLines(debug, taskId, "turn ended: cancelled") > 0 ? debug : null;
  });
  assert(hasLogLine(stopped, "stop cancelled the prompt turn"), "the stop sent a cancel");
  assert(
    countTaskLogLines(stopped, taskId, "bridge: session/cancel") > 0,
    "session/cancel reached the harness",
  );
  assertEqual(stopped.state.status, "running", "the workflow keeps running");
  assertEqual(taskById(stopped, taskId).status, status, "the author keeps its status");
  assertEqual(countSessionPosts(stopped), countSessionPosts(before), "nothing posted after Stop");
}

/** Moves the issue to Canceled and waits for the workflow and task to be cancelled. */
async function cancelFromIssue(workflowId: string, taskId: string): Promise<void> {
  const before = await fetchWorkflowDebug(workflowId);
  const startedState = LINEAR_TEAM_STATES.find((state) => state.type === "started")!;
  await postLinearWebhook(
    issueStateChanged({
      issue: SECOND_ISSUE,
      from: startedState,
      to: LINEAR_CANCELED_STATE,
      actor: linearDev,
    }),
    "Issue",
  );
  const cancelled = await waitUntil({ label: "second workflow cancelled" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const isCancelled =
      debug.state.status === "cancelled" && taskById(debug, taskId).status === "cancelled";
    return isCancelled ? debug : null;
  });
  assertEqual(
    countSessionPosts(cancelled),
    countSessionPosts(before),
    "the cancellation stays out of the session",
  );
}

/** Runs step 8. */
export async function runCancel(): Promise<void> {
  console.log("\n8. Stop and cancel");
  const { workflowId, taskId } = await createWorkflowFromIssue({
    sessionId: THIRD_SESSION,
    issue: SECOND_ISSUE,
    label: "second workflow",
  });
  await assertStartsSince(0, 1, "mock sandbox saw one start for the second workflow", taskId);

  await pressStop(workflowId, taskId);
  await cancelFromIssue(workflowId, taskId);
  const exit = await waitForSandboxDestroyed(taskId, "/destroy reached the mock sandbox");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
  await assertStartsSince(0, 1, "no restart after the cancel", taskId);
}
