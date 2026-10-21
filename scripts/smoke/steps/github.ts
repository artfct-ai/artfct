/**
 * Step 4. GitHub events on the open pull request. Each one reaches the workflow through the
 * webhook route, and none of them prompts the harness or restarts the sandbox.
 */
import {
  artifactOf,
  countTurns,
  fetchConversationDebug,
  taskById,
  waitUntil,
  type ConversationDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { STAGE_NAMES } from "../config";
import {
  agentBotFixture,
  checkSuiteEvent,
  pullRequestEvent,
  pullRequestFixture,
  pushToMainEvent,
  reviewEvent,
  type PullRequestFixture,
} from "../fixtures";
import { assertStartsSince, startCountBaseline } from "../sandbox";
import { postGithubWebhook } from "../webhooks";

/** Inputs for the GitHub events. `branch` is the head ref the task pushed to. */
export type GithubEventsOptions = { conversationId: string; taskId: string; branch: string };

/** Time a wake would need to show up as a harness turn or a sandbox start. */
const SETTLE_MS = 750;

/**
 * Opens the PR (idempotent with the artifact from step 3) and reports a failed check suite. The
 * workflow reads the checks from the code host and the smoke stack has none, so the event alone
 * prompts nobody.
 */
async function openPrAndReportChecks(conversationId: string, pullRequest: PullRequestFixture) {
  const opened = await postGithubWebhook(
    "pull_request",
    pullRequestEvent("opened", pullRequest, agentBotFixture),
  );
  assertEqual(
    opened.conversational.conversation_id,
    conversationId,
    "PR opened event routed by branch",
  );
  const reported = await postGithubWebhook("check_suite", checkSuiteEvent(pullRequest, "failure"));
  assertEqual(
    reported.conversational.conversation_id,
    conversationId,
    "check suite event routed by branch",
  );
}

/** A push to `main`. Ingress fans it out to the workflow with an open PR in the repo. */
async function pushBaseBranch(conversationId: string) {
  const reply = await postGithubWebhook("push", pushToMainEvent());
  assertEqual(reply.conversational.fanned_out, 1, "base push fanned out to the one open PR");

  const debug = await fetchConversationDebug(conversationId);
  const note = debug.inbox.find((row) => row.text.includes("pull_action=base_moved"));
  assert(note !== undefined, "base push queued a note for the agent", debug.inbox);
  assert(
    note.text.includes("The system reads the checks and the merge"),
    "note says the system reads the merge itself",
    note.text,
  );
}

/**
 * An approving review with nothing to say is noted and changes nothing here. A redelivery of it
 * under the same delivery id is a duplicate.
 */
async function approvePrTwice(
  conversationId: string,
  taskId: string,
  pullRequest: PullRequestFixture,
) {
  const before = await fetchConversationDebug(conversationId);
  const delivery = crypto.randomUUID();
  const approval = reviewEvent({ pullRequest, state: "approved", body: "" });
  await postGithubWebhook("pull_request_review", approval, delivery);
  const noted = await waitUntil({ label: "empty approving review noted" }, async () => {
    const debug = await fetchConversationDebug(conversationId);
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

  const again = await postGithubWebhook("pull_request_review", approval, delivery);
  assertEqual(
    (again.conversational.result as { duplicate?: boolean } | undefined)?.duplicate,
    true,
    "a redelivered review is a duplicate",
  );
}

/** None of the events prompted the harness, restarted the sandbox, or added an artifact. */
async function assertNothingWoke(options: {
  before: ConversationDebug;
  taskId: string;
  startsBefore: number;
}) {
  const { before, taskId, startsBefore } = options;
  await Bun.sleep(SETTLE_MS);
  const after = await fetchConversationDebug(before.conversation.conversation_id);
  assertEqual(countTurns(after), countTurns(before), "no GitHub event prompted the harness");
  assertEqual(
    after.artifacts.length,
    STAGE_NAMES.length,
    "PR opened event did not add an artifact",
  );
  assertEqual(
    taskById(after, taskId).sandbox?.generation,
    taskById(before, taskId).sandbox?.generation,
    "no sandbox restart",
  );
  await assertStartsSince(startsBefore, 0, "no new sandbox start after the events", taskId);
}

/** Runs step 4. */
export async function runGithubEvents(options: GithubEventsOptions): Promise<void> {
  const { conversationId, taskId, branch } = options;
  const pullRequest = pullRequestFixture(branch);
  console.log("\n4. GitHub events");
  const before = await fetchConversationDebug(conversationId);
  const startsBefore = await startCountBaseline(taskId);

  await openPrAndReportChecks(conversationId, pullRequest);
  await pushBaseBranch(conversationId);
  await approvePrTwice(conversationId, taskId, pullRequest);
  await assertNothingWoke({ before, taskId, startsBefore });
}
