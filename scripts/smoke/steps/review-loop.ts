/**
 * Step 6. GitHub events drive the review loop, from PR opened through to approval. Every event
 * that should prompt the harness is checked against a turn-count baseline taken just before.
 */
import {
  artifactOf,
  countOutboxMessages,
  countTurns,
  fetchWorkflowDebug,
  hasLogLine,
  outboxText,
  taskById,
  turnBaseline,
  waitForAgentIdle,
  waitForRefinersReleased,
  waitForTurns,
  waitUntil,
  type WorkflowDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { STAGE_NAMES } from "../config";
import { PR_STAGE_NAME } from "../../../packages/orchestrator/test/smoke-config";
import {
  agentBotFixture,
  agentSessionCreated,
  agentSessionPrompted,
  checkSuiteEvent,
  linearDev,
  linearPm,
  linearSessionId,
  pullRequestEvent,
  pullRequestFixture,
  pushToMainEvent,
  REVIEW_IDS,
  reviewBotFixture,
  reviewCommentEvent,
  reviewEvent,
  type PullRequestFixture,
} from "../fixtures";
import { assertStartsSince, startCountBaseline } from "../sandbox";
import { postGithubWebhook, postLinearWebhook } from "../webhooks";
import { FIRST_ISSUE, FIRST_SESSION } from "./linear-start";

/** Inputs for the review loop. `branch` is the head ref the task pushed to. */
export type ReviewLoopOptions = { workflowId: string; taskId: string; branch: string };

/** The second session a PM opens on the same issue. */
const SECOND_SESSION = linearSessionId(2);

/** Time a wake would need to show up as a harness turn or a sandbox start. */
const SETTLE_MS = 750;

/**
 * Opens the PR (idempotent with the artifact from step 3) and reports a failed check suite. The
 * workflow reads the checks from the code host and the smoke stack has none, so the event alone
 * prompts nobody.
 */
async function openPrAndReportChecks(
  workflowId: string,
  taskId: string,
  pullRequest: PullRequestFixture,
) {
  const baseline = await turnBaseline(workflowId);
  const opened = await postGithubWebhook(
    "pull_request",
    pullRequestEvent("opened", pullRequest, agentBotFixture),
  );
  assertEqual(opened.workflow_id, workflowId, "PR opened event routed by branch");
  const reported = await postGithubWebhook("check_suite", checkSuiteEvent(pullRequest, "failure"));
  assertEqual(reported.workflow_id, workflowId, "check suite event routed by branch");
  await Bun.sleep(SETTLE_MS);
  const debug = await waitForRefinersReleased(workflowId, taskId);
  assertEqual(countTurns(debug), baseline, "the check suite event did not prompt the harness");
  assertEqual(
    debug.artifacts.length,
    STAGE_NAMES.length,
    "PR opened event did not add an artifact",
  );
}

/**
 * Submits a changes_requested review and checks it reaches the harness. The follow-up moves the
 * job's boards to the end of their threads, and the harness turn reopens the released artifact,
 * so the release after the re-run is waited for too.
 */
async function requestChanges(workflowId: string, taskId: string, pullRequest: PullRequestFixture) {
  const before = await fetchWorkflowDebug(workflowId);
  const baseline = await turnBaseline(workflowId);
  await postGithubWebhook(
    "pull_request_review",
    reviewEvent({
      pullRequest,
      state: "changes_requested",
      body: "Please add a test for the redirect.",
    }),
  );
  await waitForTurns({
    workflowId,
    baseline,
    expected: 1,
    label: "review changes reached the harness through the orchestrator",
  });
  const after = await waitForRefinersReleased(workflowId, taskId);
  assertBoardsMoved(before, after, taskById(after, taskId).job_id);
}

/**
 * Every board of the job moved once: one new message per board, the previous message deleted,
 * and every later edit made in place on the new message.
 */
function assertBoardsMoved(before: WorkflowDebug, after: WorkflowDebug, jobId: string) {
  const posted = after.outbox.slice(before.outbox.length).filter((message) => {
    return message.channel === "board";
  });
  const boards = after.boards.filter((board) => board.job_id === jobId);
  const creates = posted.filter((message) => message.kind === "create");
  assertEqual(
    creates.length,
    boards.length,
    `${jobId}: one board create per channel on the follow-up`,
  );
  for (const board of boards) {
    const previous = before.boards.find(
      (row) => row.job_id === jobId && row.channel_key === board.channel_key,
    )?.message_id;
    assert(
      previous != null && previous !== board.message_id,
      `${board.channel_key}: the board moved to a new message`,
      { previous, board },
    );
    assertEqual(board.relocate, 0, `${board.channel_key}: the move is done`);
    const deleted = posted.findIndex(
      (message) => message.kind === "delete" && message.payload.messageId === previous,
    );
    assert(deleted >= 0, `${board.channel_key}: the previous message is deleted`, posted);
    const edits = posted.slice(deleted).filter((message) => message.kind === "edit");
    assert(
      edits.length > 0 && edits.every((edit) => edit.payload.messageId === board.message_id),
      `${board.channel_key}: the moved board is edited in place`,
      edits.map((edit) => edit.payload.messageId),
    );
  }
}

/**
 * A review with an empty body that says everything in its inline comments. The comment carrying
 * the feedback reaches the orchestrator, which sends it on to the harness.
 */
async function commentWithoutApproving(
  workflowId: string,
  taskId: string,
  pullRequest: PullRequestFixture,
) {
  const empty = await turnBaseline(workflowId);
  await postGithubWebhook(
    "pull_request_review",
    reviewEvent({ pullRequest, state: "commented", body: "" }),
  );
  const afterReview = await waitUntil({ label: "empty review noted for the agent" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const noted = debug.inbox.some((row) => row.text.includes("feedback: nothing to record."));
    return noted ? debug : null;
  });
  assertEqual(countTurns(afterReview), empty, "an empty review did not prompt the harness");

  const baseline = await turnBaseline(workflowId);
  const comment = { path: "src/login.ts", line: 42, body: "This is overspecified." };
  const delivery = crypto.randomUUID();
  const first = await postGithubWebhook(
    "pull_request_review_comment",
    reviewCommentEvent({ pullRequest, comment }),
    delivery,
  );
  assertEqual(first.workflow_id, workflowId, "review comment routed to the workflow");
  const debug = await waitForTurns({
    workflowId,
    baseline,
    expected: 1,
    label: "a review comment reached the harness through the orchestrator",
  });
  assert(hasLogLine(debug, "sam reviewed"), "the review was noted", debug.log.slice(-5));

  const again = await postGithubWebhook(
    "pull_request_review_comment",
    reviewCommentEvent({ pullRequest, comment }),
    delivery,
  );
  assertEqual(
    (again.result as { duplicate?: boolean } | undefined)?.duplicate,
    true,
    "a redelivered review comment is a duplicate",
  );
  const after = await waitForRefinersReleased(workflowId, taskId);
  assertEqual(countTurns(after), countTurns(debug), "the redelivery did not prompt the harness");
}

/**
 * The same review, submitted by a review App the repository installed. An App is
 * authorized without a permission lookup, and the review is recorded, noted, and sent on to the
 * harness.
 */
async function reviewedByAnAgent(
  workflowId: string,
  taskId: string,
  pullRequest: PullRequestFixture,
) {
  const baseline = await turnBaseline(workflowId);
  const delivery = crypto.randomUUID();
  const submitted = await postGithubWebhook(
    "pull_request_review",
    reviewEvent({
      pullRequest,
      state: "changes_requested",
      body: "The redirect still drops the error.",
      reviewer: reviewBotFixture,
      reviewId: REVIEW_IDS.agent,
    }),
    delivery,
  );
  assertEqual(submitted.workflow_id, workflowId, "an app's review routed to the workflow");
  const debug = await waitForTurns({
    workflowId,
    baseline,
    expected: 1,
    label: "an app's review prompted the harness",
  });
  assert(
    hasLogLine(debug, "acme-review[bot] reviewed"),
    "the app's review was noted like anyone's",
    debug.log.slice(-5),
  );

  const again = await postGithubWebhook(
    "pull_request_review",
    reviewEvent({
      pullRequest,
      state: "changes_requested",
      body: "The redirect still drops the error.",
      reviewer: reviewBotFixture,
      reviewId: REVIEW_IDS.agent,
    }),
    delivery,
  );
  assertEqual(
    (again.result as { duplicate?: boolean } | undefined)?.duplicate,
    true,
    "a redelivered app review is a duplicate",
  );
  const after = await waitForRefinersReleased(workflowId, taskId);
  assertEqual(countTurns(after), countTurns(debug), "the redelivery did not prompt the harness");
}

/**
 * A push to `main`. Ingress fans it out to the workflow with an open PR in the repo, and the
 * note is queued for the agent without a wake. No harness turn, no sandbox restart.
 */
async function pushBaseBranch(workflowId: string, taskId: string) {
  const before = await waitForAgentIdle(workflowId);
  const baseline = countTurns(before);
  const startsBefore = await startCountBaseline(taskId);

  const reply = await postGithubWebhook("push", pushToMainEvent());
  assertEqual(reply.fanned_out, 1, "base push fanned out to the one open PR");

  const debug = await fetchWorkflowDebug(workflowId);
  const note = debug.inbox.find((row) => row.text.includes("pull_action=base_moved"));
  assert(note !== undefined, "base push queued a note for the agent", debug.inbox);
  assert(
    note.text.includes("The system reads the checks and the merge"),
    "note says the system reads the merge itself",
    note.text,
  );

  await Bun.sleep(SETTLE_MS);
  const after = await fetchWorkflowDebug(workflowId);
  assertEqual(countTurns(after), baseline, "no harness turn after the base push");
  assertEqual(
    taskById(after, taskId).sandbox?.generation,
    taskById(before, taskId).sandbox?.generation,
    "no sandbox restart",
  );
  await assertStartsSince(startsBefore, 0, "no new sandbox start after the base push", taskId);
}

/** A Linear status reply. */
function isStatusReply(message: WorkflowDebug["outbox"][number]): boolean {
  return (
    message.channel === "tracker" &&
    message.kind === "response" &&
    outboxText(message).includes("Cost so far")
  );
}

/**
 * Asks for status on the first Linear session and checks the orchestrator answers itself.
 * Earlier stages asked too, so the check waits for a new reply and reads the latest one.
 */
async function queryStatusFromLinear(workflowId: string) {
  const before = await fetchWorkflowDebug(workflowId);
  const baseline = countTurns(before);
  const replies = countOutboxMessages(before, isStatusReply);
  await postLinearWebhook(
    agentSessionPrompted({
      sessionId: FIRST_SESSION,
      creator: linearDev,
      issue: FIRST_ISSUE,
      body: "status?",
    }),
  );
  const debug = await waitUntil({ label: "status posted to Linear" }, async () => {
    const dump = await fetchWorkflowDebug(workflowId);
    if (countOutboxMessages(dump, isStatusReply) <= replies) return null;
    return { dump, text: outboxText(dump.outbox.filter(isStatusReply).at(-1)!) };
  });
  assert(
    debug.text.includes(`Workflow ${workflowId}: running`),
    "status names the workflow and its state",
    debug.text,
  );
  assert(
    debug.text.includes(`[${PR_STAGE_NAME}]:`),
    "status names the PR stage of the running task",
    debug.text,
  );
  assertEqual(countTurns(debug.dump), baseline, "status query did not prompt the harness");
}

/** A second Linear session on the same issue routes to the same workflow as a prompt. */
async function openSecondLinearSession(workflowId: string) {
  const baseline = await turnBaseline(workflowId);
  const reply = await postLinearWebhook(
    agentSessionCreated({
      sessionId: SECOND_SESSION,
      creator: linearPm,
      issue: FIRST_ISSUE,
      comment: "Also update the docs page.",
    }),
  );
  assertEqual(reply.workflow_id, workflowId, "second session routed to the same workflow");
  assertEqual(reply.created, false, "second session created no workflow");
  assertEqual(reply.joined, true, "second session joined the workflow");
  await waitUntil({ label: "second session reply target added" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const joined = debug.state.reply_targets.some(
      (target) => target.source === "tracker" && target.session_id === SECOND_SESSION,
    );
    return joined ? debug : null;
  });
  await waitForTurns({
    workflowId,
    baseline,
    expected: 1,
    label: "second session prompt reached the harness",
  });
}

/**
 * An approving review with nothing to say changes nothing here. GitHub holds the approval, the
 * merge is the gate, and the harness is not prompted. The second session's prompt re-ran the
 * refiners, so their release is waited for before the states are compared.
 */
async function approvePr(workflowId: string, taskId: string, pullRequest: PullRequestFixture) {
  const before = await waitForRefinersReleased(workflowId, taskId);
  const baseline = countTurns(before);
  await postGithubWebhook(
    "pull_request_review",
    reviewEvent({ pullRequest, state: "approved", body: "" }),
  );
  const noted = await waitUntil({ label: "empty approving review noted" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return debug.inbox.some((row) => row.text.includes("feedback: nothing to record."))
      ? debug
      : null;
  });
  assertEqual(
    artifactOf(noted, taskById(noted, taskId).job_id)?.status,
    "ready",
    "artifact status unchanged",
  );
  assertEqual(
    taskById(noted, taskId).status,
    taskById(before, taskId).status,
    "task status unchanged",
  );
  assertEqual(countTurns(noted), baseline, "the approving review did not prompt the harness");
}

/** Runs step 6 end to end. */
export async function runReviewLoop(options: ReviewLoopOptions): Promise<void> {
  const { workflowId, taskId, branch } = options;
  const pullRequest = pullRequestFixture(branch);
  console.log("\n6. Review loop");

  await openPrAndReportChecks(workflowId, taskId, pullRequest);
  await requestChanges(workflowId, taskId, pullRequest);
  await commentWithoutApproving(workflowId, taskId, pullRequest);
  await reviewedByAnAgent(workflowId, taskId, pullRequest);
  await pushBaseBranch(workflowId, taskId);
  await queryStatusFromLinear(workflowId);
  await openSecondLinearSession(workflowId);
  await approvePr(workflowId, taskId, pullRequest);
}
