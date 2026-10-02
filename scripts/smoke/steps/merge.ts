/**
 * Step 7. Merging the PR closes the task and the workflow, completes the Linear issue, and
 * destroys the sandbox. The Linear bindings stay, and a late status question on them is dropped
 * without waking the workflow. The GitHub bindings go. A workflow that started in Linear addressed nothing to the chat.
 */
import {
  artifactOf,
  countAgentTurns,
  countOutboxMessages,
  fetchBindings,
  fetchWorkflowDebug,
  hasOutboxMessage,
  taskById,
  waitUntil,
  type WorkflowDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { STAGE_NAMES } from "../config";
import {
  agentSessionPrompted,
  issueStateChanged,
  LINEAR_CANCELED_STATE,
  LINEAR_TEAM_STATES,
  linearDev,
  mergedPullRequest,
  pullRequestEvent,
  pullRequestFixture,
  reviewEvent,
  samFixture,
} from "../fixtures";
import { waitForSandboxDestroyed } from "../sandbox";
import { postGithubWebhook, postLinearWebhook } from "../webhooks";
import { FIRST_ISSUE, FIRST_SESSION } from "./linear-start";

/** Inputs for the merge step. `branch` is the head ref the task pushed to. */
export type MergeOptions = { workflowId: string; taskId: string; branch: string };

/** Closes the PR as merged and waits for the workflow to finish. */
async function mergePr(options: MergeOptions): Promise<void> {
  const { workflowId, taskId, branch } = options;
  await postGithubWebhook(
    "pull_request",
    pullRequestEvent("closed", mergedPullRequest(pullRequestFixture(branch)), samFixture),
  );
  const done = await waitUntil({ label: "workflow done and linear issue completed" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const finished =
      debug.state.status === "done" &&
      taskById(debug, taskId).status === "done" &&
      hasOutboxMessage(
        debug,
        (message) => message.kind === "issue_update" && message.payload.to === "completed",
      );
    return finished ? debug : null;
  });
  assertEqual(
    artifactOf(done, taskById(done, taskId).job_id)?.status,
    "accepted",
    "artifact status",
  );
  assertEqual(
    done.jobs.map((job) => {
      const author = done.tasks.find(
        (task) => task.job_id === job.job_id && task.role === "author",
      );
      return `${job.stage}:${author?.status}`;
    }),
    STAGE_NAMES.map((stage) => `${stage}:done`),
    "one done job per stage",
  );
  assertEqual(
    done.tasks.filter((task) => task.role !== "author" && task.status !== "done").length,
    0,
    "every reviewer and polisher run is done too",
  );
  assertEqual(done.queue.length, 0, "no prompt left in the task queue");

  const exit = await waitForSandboxDestroyed(taskId, "sandbox destroyed after completion");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
}

/** A status question on the finished workflow is dropped in the router and never wakes it. */
async function askFinishedWorkflow(workflowId: string): Promise<void> {
  const before = await fetchWorkflowDebug(workflowId);
  const reply = await postLinearWebhook(
    agentSessionPrompted({
      sessionId: FIRST_SESSION,
      creator: linearDev,
      issue: FIRST_ISSUE,
      body: "status?",
    }),
  );
  assert("dropped" in reply, "late status question dropped before the finished workflow", reply);
  const after = await fetchWorkflowDebug(workflowId);
  assertEqual(after.log.length, before.log.length, "the finished workflow logged nothing");
  assertEqual(after.state.status, "done", "a status question does not reopen the workflow");
}

/** A reply to a requester. Board edits and receipts of earlier work are not replies. */
function isResponse(message: WorkflowDebug["outbox"][number]): boolean {
  return message.kind === "response";
}

/** A review on the merged pull request finds no workflow bound and reaches nothing. */
async function reviewFinishedWorkflow(options: MergeOptions): Promise<void> {
  const { workflowId, branch } = options;
  const before = await fetchWorkflowDebug(workflowId);
  const reply = await postGithubWebhook(
    "pull_request_review",
    reviewEvent({ pullRequest: pullRequestFixture(branch), state: "approved", body: "" }),
  );
  assert("dropped" in reply, "late review on the merged PR dropped in ingress", reply);
  const after = await fetchWorkflowDebug(workflowId);
  assertEqual(countAgentTurns(after), countAgentTurns(before), "no orchestrator turn for it");
  assertEqual(
    countOutboxMessages(after, isResponse),
    countOutboxMessages(before, isResponse),
    "no reply for it",
  );
  assertEqual(after.state.status, "done", "the workflow stays done");
}

/** An issue move on the finished workflow is dropped in the router, on its D1 status. */
async function cancelFinishedWorkflow(workflowId: string): Promise<void> {
  const before = await fetchWorkflowDebug(workflowId);
  const doneState = LINEAR_TEAM_STATES.find((state) => state.type === "completed")!;
  const reply = await postLinearWebhook(
    issueStateChanged({
      issue: FIRST_ISSUE,
      from: doneState,
      to: LINEAR_CANCELED_STATE,
      actor: linearDev,
    }),
    "Issue",
  );
  assert("dropped" in reply, "late issue cancel on the finished workflow dropped", reply);
  const after = await fetchWorkflowDebug(workflowId);
  assertEqual(countAgentTurns(after), countAgentTurns(before), "no orchestrator turn for it");
  assertEqual(
    countOutboxMessages(after, isResponse),
    countOutboxMessages(before, isResponse),
    "no reply for it",
  );
  assertEqual(after.state.status, "done", "the workflow stays done");
}

/** A workflow the tracker started narrates itself there. The chat never hears about it. */
function assertNothingOnChat(last: WorkflowDebug): void {
  assert(
    !hasOutboxMessage(last, (message) => message.channel === "chat"),
    "the Linear workflow addressed no chat message from its first event to its last",
    last.outbox.filter((message) => message.channel === "chat"),
  );
}

/** Runs step 7 and returns the final debug dump for the summary line. */
export async function runMerge(options: MergeOptions): Promise<WorkflowDebug> {
  console.log("\n7. Merge");
  await mergePr(options);

  const left = await waitUntil({ label: "github bindings dropped on completion" }, async () => {
    const bindings = await fetchBindings();
    const owned = bindings.filter((binding) => binding.workflow_id === options.workflowId);
    const dropped = owned.every(
      (binding) => binding.source !== "code_pull" && binding.source !== "code_branch",
    );
    return dropped ? owned : null;
  });
  assert(
    left.some((binding) => binding.source === "tracker_issue"),
    "tracker bindings kept on completion",
    left,
  );

  await askFinishedWorkflow(options.workflowId);
  await reviewFinishedWorkflow(options);
  await cancelFinishedWorkflow(options.workflowId);

  const last = await fetchWorkflowDebug(options.workflowId);
  assertNothingOnChat(last);
  return last;
}
