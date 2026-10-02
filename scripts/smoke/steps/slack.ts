/**
 * Step 11. A Slack @mention starts a workflow in a thread. A white_check_mark reaction accepts
 * each document, and a thread reply selects an option on the model stage, so the workflow runs on
 * to its pull request. A second mention in the channel root gets a workflow of its own, though it
 * links the pull request the first one owns. A third mention links a page the workflow did not
 * produce, and its workflow starts at the stage after the one that writes that page.
 */
import {
  artifactOf,
  authorTaskOf,
  fetchBindings,
  fetchWorkflowDebug,
  hasLogLine,
  hasOutboxMessage,
  taskById,
  waitForHandoverRead,
  waitUntil,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { PAGE_PARENT_ID, REPO_FULL_NAME, RUN_ID, SELECTED_OPTION, STAGE_NAMES } from "../config";
import { DOC_STAGES, MODEL_DOC_STAGE } from "../../../packages/orchestrator/test/smoke-config";
import {
  SLACK_BOT_USER_ID,
  docUrlForStage,
  slackMention,
  slackReaction,
  slackThreadReply,
} from "../fixtures";
import { createMockNotionPage, fetchMockNotionPages } from "../harness";
import { postSlackEvent } from "../webhooks";

const SLACK_CHANNEL = "C1";
const MENTIONER = "U1";
const APPROVER = "U2";

/** Mentions the bot in a new thread and returns the workflow id bound to that thread. */
async function startWorkflowFromMention(threadTs: string, text: string): Promise<string> {
  const reply = await postSlackEvent(
    slackMention({ channel: SLACK_CHANNEL, ts: threadTs, user: MENTIONER, text }),
  );
  assertEqual(reply.ok, true, "slack event acknowledged before processing");
  const binding = await waitUntil({ label: "slack thread bound to a new workflow" }, async () => {
    const bindings = await fetchBindings();
    return (
      bindings.find(
        (row) => row.source === "chat_thread" && row.external_id === `${SLACK_CHANNEL}:${threadTs}`,
      ) ?? null
    );
  });
  return binding.workflow_id;
}

/** The answer that completes a stage in the thread. */
function completingEvent(stage: string, threadTs: string): Record<string, unknown> {
  if (stage === MODEL_DOC_STAGE) {
    return slackThreadReply({
      channel: SLACK_CHANNEL,
      threadTs,
      user: APPROVER,
      text: `go with ${SELECTED_OPTION}`,
    });
  }
  return slackReaction({
    channel: SLACK_CHANNEL,
    ts: threadTs,
    user: APPROVER,
    reaction: "white_check_mark",
  });
}

/** Answers in the thread once the humans have the document of the stage of `stageIndex`. */
async function completeInThread(
  workflowId: string,
  threadTs: string,
  stageIndex: number,
): Promise<void> {
  const stage = STAGE_NAMES[stageIndex]!;
  const next = STAGE_NAMES[stageIndex + 1]!;
  const started = await waitUntil({ label: `${stage} wrote its document` }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const task = authorTaskOf(debug, stage);
    return task && artifactOf(debug, task.job_id) ? task : null;
  });
  const taskId = started.task_id;
  const jobId = started.job_id;
  await waitForHandoverRead(workflowId, jobId);
  await postSlackEvent(completingEvent(stage, threadTs));
  const accepted = await waitUntil({ label: `thread answer completed ${taskId}` }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return taskById(debug, taskId).status === "done" ? debug : null;
  });
  assert(hasLogLine(accepted, "event prompt"), "the answer arrived as a prompt", accepted.log);
  assert(
    accepted.boards.some((board) => board.job_id === jobId && board.message_id === "local:chat"),
    `board posted to the Slack thread for ${jobId}`,
    accepted.boards,
  );
  await waitUntil({ label: `workflow started the ${next} stage` }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return authorTaskOf(debug, next) ?? null;
  });
}

/**
 * The pull request of the last stage, recorded as the task artifact and bound to the workflow.
 * A request in the channel root must not be routed by this binding.
 */
async function waitForPullRequest(workflowId: string): Promise<string> {
  const artifact = await waitUntil(
    { label: "slack workflow opened a pull request", timeoutMs: 30_000 },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      return debug.artifacts.find((row) => row.kind === "pull") ?? null;
    },
  );
  await waitUntil({ label: "the pull request is bound to the slack workflow" }, async () => {
    const bindings = await fetchBindings();
    return bindings.some((row) => row.source === "code_pull" && row.workflow_id === workflowId);
  });
  return artifact.external_url;
}

/**
 * A mention in the channel root is a new request, even when it links the pull request of the
 * workflow already running in the channel. It gets its own workflow, job 1, and its own thread.
 */
async function startSecondRequestInChannel(firstWorkflowId: string, prUrl: string): Promise<void> {
  const before = await fetchWorkflowDebug(firstWorkflowId);
  const threadTs = `17001${RUN_ID.length}.${Date.now() % 100000}`;
  const secondId = await startWorkflowFromMention(
    threadTs,
    `<@${SLACK_BOT_USER_ID}> the replies on <${prUrl}|the pull request> were noisy, fix that next`,
  );
  assert(secondId !== firstWorkflowId, "channel mention started its own workflow", secondId);
  const board = await waitUntil(
    { label: "second request boarded its first job", timeoutMs: 30_000 },
    async () => {
      const debug = await fetchWorkflowDebug(secondId);
      return debug.boards.find((row) => row.job_id === `${secondId}-1`) ?? null;
    },
  );
  assertEqual(
    board.channel_key,
    `chat:${SLACK_CHANNEL}:${threadTs}`,
    "the new request boards its first job in its own thread",
  );
  const after = await fetchWorkflowDebug(firstWorkflowId);
  assertEqual(
    after.jobs.length,
    before.jobs.length,
    "no job appended to the workflow that owns the pull request",
  );
}

/** The text of the page a person wrote outside the workflow and links from the channel. */
const GIVEN_PAGE_TEXT = "## Design\nThe notification service reads the outbox.";

/**
 * A mention that links a page the workflow did not produce starts at the stage after the one that
 * writes that page. The job works from the page, and its author reads the page text.
 */
async function startRequestFromPage(): Promise<void> {
  const page = await createMockNotionPage("Notification service (design)", GIVEN_PAGE_TEXT);
  const threadTs = `17002${RUN_ID.length}.${Date.now() % 100000}`;
  const workflowId = await startWorkflowFromMention(
    threadTs,
    `<@${SLACK_BOT_USER_ID}> heres a design doc <${page.url}|design doc> for a new service in <https://github.com/${REPO_FULL_NAME}|acme/app>, please kick off writing a plan for it\nPage parent: ${PAGE_PARENT_ID}`,
  );
  const stage = STAGE_NAMES[1]!;
  const planned = await waitUntil({ label: "page request planned its stages" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return debug.state.stages.length ? debug : null;
  });
  assertEqual(planned.state.stages, STAGE_NAMES.slice(1), "the plan starts after the page's stage");
  const job = await waitUntil({ label: `job started for ${stage} from the page` }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return debug.jobs.find((row) => row.stage === stage) ?? null;
  });
  assertEqual(job.input_ref, { kind: "page", page_id: page.id }, "the job works from the page");
  assertEqual(job.input_url, page.url, "the job keeps the link the request gave");
  const artifact = await waitUntil(
    { label: `${stage} wrote its page from the given page`, timeoutMs: 30_000 },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      const task = authorTaskOf(debug, stage);
      return task ? artifactOf(debug, task.job_id) : null;
    },
  );
  const written = (await fetchMockNotionPages()).find((row) =>
    artifact.external_url.endsWith(row.id),
  );
  assert(written !== undefined, "the author created its page on the host", artifact);
  assertEqual(written.parent_id, PAGE_PARENT_ID, "the page is under the page parent");
  assert(
    written.markdown_versions[0]!.includes(GIVEN_PAGE_TEXT),
    "the author read the given page",
    written.markdown_versions[0],
  );
}

/** Runs step 11. */
export async function runSlack(): Promise<void> {
  console.log("\n11. Slack");
  const threadTs = `17000${RUN_ID.length}.${Date.now() % 100000}`;
  const workflowId = await startWorkflowFromMention(
    threadTs,
    `<@${SLACK_BOT_USER_ID}> fix the flaky checkout test in <https://github.com/${REPO_FULL_NAME}|acme/app>\nPage parent: ${PAGE_PARENT_ID}`,
  );
  const firstStage = STAGE_NAMES[0]!;

  const withDoc = await waitUntil(
    { label: "slack workflow wrote a document and replied in thread", timeoutMs: 30_000 },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      const hasThreadReply = hasOutboxMessage(
        debug,
        (message) => message.channel === "chat" && message.kind === "artifact_ready",
      );
      return debug.artifacts[0] && hasThreadReply ? debug : null;
    },
  );
  assertEqual(withDoc.state.stages, STAGE_NAMES, "slack workflow planned every stage");
  assertEqual(withDoc.artifacts[0]?.external_url, docUrlForStage(firstStage), "artifact url");
  assertEqual(withDoc.artifacts[0]?.kind, "page", "artifact kind");
  assert(
    hasOutboxMessage(
      withDoc,
      (message) =>
        message.channel === "chat" &&
        message.kind === "acknowledge" &&
        message.payload.message === threadTs,
    ),
    "mention acknowledged in the thread",
    withDoc.outbox,
  );

  await completeInThread(workflowId, threadTs, 0);

  const final = await fetchWorkflowDebug(workflowId);
  assertEqual(final.state.reply_targets.length, 1, "slack workflow has one reply target");
  assertEqual(
    final.state.reply_targets[0],
    { source: "chat", channel: SLACK_CHANNEL, thread: threadTs },
    "reply target is the thread",
  );

  for (let index = 1; index < DOC_STAGES.length; index += 1) {
    await completeInThread(workflowId, threadTs, index);
  }
  await startSecondRequestInChannel(workflowId, await waitForPullRequest(workflowId));
  await startRequestFromPage();
}
