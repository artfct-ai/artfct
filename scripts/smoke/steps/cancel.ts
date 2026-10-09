/**
 * Step 8. A fresh workflow is provisioned on the PR stage, with the delegated issue as its job's
 * input, and its author's first turn never finishes. A message in the session on that issue, its
 * job session, goes straight to the running author, and the Stop button ends that turn and
 * drops the message while the workflow runs on. A second Stop on the idle author ends its session
 * feed again. Moving the issue to Canceled then cancels the workflow: one start, one destroy.
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
import { PR_STAGE_NAME } from "../../../packages/orchestrator/test/smoke-config";
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
import { activityBodies, fetchMockLinearState, registerMockIssue } from "../linear-api";
import { assertStartsSince, waitForSandboxDestroyed } from "../sandbox";
import { postLinearWebhook } from "../webhooks";

const THIRD_SESSION = linearSessionId(3);
const STOPPED_REPLY = "Stopped.";
const SECOND_ISSUE = linearIssue(
  2,
  "ENG-43",
  "Add dark mode",
  `Make it dark. Never finish this. Repo: https://github.com/${REPO_FULL_NAME}\nPage parent: ${PAGE_PARENT_ID}\nStage: ${PR_STAGE_NAME}`,
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

/** How long the harness gets to show it did not start the dropped prompt. */
const DROPPED_PROMPT_GRACE_MS = 1_000;

/** Waits until the job session holds `count` stopped replies and the last activity is one. */
async function waitForStoppedReplies(count: number, label: string): Promise<void> {
  await waitUntil({ label }, async () => {
    const bodies = activityBodies(await fetchMockLinearState(), THIRD_SESSION);
    const stoppedReplies = bodies.filter((body) => body === STOPPED_REPLY).length;
    return stoppedReplies === count && bodies.at(-1) === STOPPED_REPLY;
  });
}

/**
 * The Stop button cancels the author's prompt turn, drops the message queued behind it, and ends
 * the session feed with the stopped reply. The task and the workflow keep running.
 */
async function pressStop(workflowId: string, taskId: string): Promise<void> {
  const before = await forwardToAuthor(workflowId, taskId);
  const status = taskById(before, taskId).status;
  await writeInSession("Stop", "stop");
  const stopped = await waitUntil({ label: "the author's turn ended on the stop" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return countTaskLogLines(debug, taskId, "turn ended: cancelled") > 0 ? debug : null;
  });
  assert(hasLogLine(stopped, "stop: cancelled"), "the stop sent a cancel");
  assert(
    countTaskLogLines(stopped, taskId, "bridge: session/cancel") > 0,
    "session/cancel reached the harness",
  );
  await waitForStoppedReplies(1, "the session feed ended with the stopped reply");
  await Bun.sleep(DROPPED_PROMPT_GRACE_MS);
  const settled = await fetchWorkflowDebug(workflowId);
  assertEqual(
    countTaskLogLines(settled, taskId, "permission:"),
    countTaskLogLines(stopped, taskId, "permission:"),
    "the harness did not get the queued prompt",
  );
  assertEqual(settled.state.status, "running", "the workflow keeps running");
  assertEqual(taskById(settled, taskId).status, status, "the author keeps its status");
  assertEqual(countSessionPosts(settled), countSessionPosts(before), "nothing posted after Stop");
}

/** The Stop button on an idle author ends its session feed with the stopped reply again. */
async function pressStopWhileIdle(workflowId: string, taskId: string): Promise<void> {
  const before = await fetchWorkflowDebug(workflowId);
  await writeInSession("Stop", "stop");
  await waitForStoppedReplies(2, "the idle author's session feed ended with the stopped reply");
  const stopped = await fetchWorkflowDebug(workflowId);
  assert(hasLogLine(stopped, "stop: idle"), "the stop found the author idle");
  assertEqual(stopped.state.status, "running", "the workflow keeps running");
  assertEqual(
    countTaskLogLines(stopped, taskId, "bridge: session/cancel"),
    countTaskLogLines(before, taskId, "bridge: session/cancel"),
    "the idle author got no cancel",
  );
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
  await registerMockIssue(SECOND_ISSUE);
  const { workflowId, taskId } = await createWorkflowFromIssue({
    sessionId: THIRD_SESSION,
    issue: SECOND_ISSUE,
    label: "second workflow",
  });
  await assertStartsSince(0, 1, "mock sandbox saw one start for the second workflow", taskId);

  await pressStop(workflowId, taskId);
  await pressStopWhileIdle(workflowId, taskId);
  await cancelFromIssue(workflowId, taskId);
  const exit = await waitForSandboxDestroyed(taskId, "/destroy reached the mock sandbox");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
  await assertStartsSince(0, 1, "no restart after the cancel", taskId);
}
