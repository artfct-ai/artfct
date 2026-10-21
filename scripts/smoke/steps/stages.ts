/**
 * Step 2. The document stages. A harness author writes a Notion page, the orchestrator records
 * it, a plain Linear reply accepts it, and the next stage starts in a fresh sandbox. The model
 * stage runs a researcher and a model-call author and completes on a selection. The last advance
 * starts the PR stage, whose task the later steps drive.
 */
import { parseDocumentOptions } from "../../../packages/orchestrator/src/artifact/options";
import { SCRIPTED_AUTHOR_OPTIONS } from "../../../packages/orchestrator/test/scripted-model";
import { ORCHESTRATOR_BRANCH_PREFIX } from "../../../packages/adapters/src/code/branch-prefix";
import { mockResearchPayload } from "../../../packages/bridge/test/mock-harness-research";
import {
  artifactOf,
  authorTaskOf,
  countLogLines,
  countTaskLogLines,
  countOutboxMessages,
  countTurns,
  fetchBindings,
  fetchConversationDebug,
  handedOverLine,
  hasLogLine,
  hasOutboxMessage,
  jobById,
  outboxText,
  taskById,
  turnBaseline,
  waitForHandoverRead,
  waitForTurns,
  waitUntil,
  type ConversationDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { authorTurnsThrough, PAGE_PARENT_ID, SELECTED_OPTION, STAGE_NAMES } from "../config";
import {
  DOC_STAGES,
  MODEL_DOC_STAGE,
  REVIEWED_DOC_STAGE,
} from "../../../packages/orchestrator/test/smoke-config";
import { agentSessionPrompted, docUrlForStage, linearDev, notionPageId } from "../fixtures";
import { fetchMockNotionComments, fetchMockNotionPages } from "../harness";
import { assertStartSpec, assertStartsSince, waitForSandboxDestroyed } from "../sandbox";
import { postLinearWebhook } from "../webhooks";
import { FIRST_ISSUE, FIRST_SESSION } from "./linear-start";

/** Inputs for the document stages: the workflow and the task of its first stage. */
export type DocumentStagesOptions = { conversationId: string; taskId: string };

/** What the PR steps need: the task of the PR stage and its branch. */
export type DocumentStagesResult = { taskId: string; branch: string };

type DebugTask = ConversationDebug["tasks"][number];

/** Slug of the first issue's title, as the branch name carries it. */
const TITLE_SLUG = "eng-42-fix-login-redirect";

/** The reply that accepts a document. */
const ACCEPT_REPLY = "looks good, go ahead";

/** A Linear status reply. */
function isStatusReply(message: ConversationDebug["outbox"][number]): boolean {
  return (
    message.channel === "tracker" &&
    message.kind === "response" &&
    outboxText(message).includes("Cost so far")
  );
}

/** Posts a reply on the Linear session of the first workflow. */
async function replyOnLinear(body: string): Promise<void> {
  await postLinearWebhook(
    agentSessionPrompted({
      sessionId: FIRST_SESSION,
      creator: linearDev,
      issue: FIRST_ISSUE,
      body,
    }),
  );
}

/** The task of a stage that starts in a sandbox: its researcher on the model stage, else its author. */
function sandboxedTaskOf(debug: ConversationDebug, stage: string): DebugTask | undefined {
  if (stage !== MODEL_DOC_STAGE) return authorTaskOf(debug, stage);
  const job = debug.jobs.find((row) => row.stage === stage);
  return debug.tasks.find((task) => task.job_id === job?.job_id && task.role === "researcher");
}

/** Waits until the humans heard about a document on Linear, and checks that its page is bound. */
async function assertDocumentAnnounced(options: {
  conversationId: string;
  stage: string;
  url: string;
  pageId: string;
}): Promise<void> {
  const { conversationId, stage, url, pageId } = options;
  await waitUntil({ label: `${stage}: linear response links the document` }, async () =>
    hasOutboxMessage(
      await fetchConversationDebug(conversationId),
      (message) =>
        message.channel === "tracker" &&
        message.kind === "response" &&
        outboxText(message).includes(url),
    ),
  );
  const bindings = await fetchBindings();
  assert(
    bindings.some(
      (binding) =>
        binding.conversation_id === conversationId &&
        binding.source === "documents_page" &&
        binding.external_id === pageId,
    ),
    `${stage}: notion_page binding exists`,
    bindings.filter((binding) => binding.conversation_id === conversationId),
  );
}

/**
 * Waits for the document of a stage to reach the humans and checks the artifact, the task, and
 * the announcement. A reviewed stage gets there only once its agent review ends.
 */
async function assertDocumentRecorded(options: {
  conversationId: string;
  taskId: string;
  stage: string;
  expectedTurns: number;
}): Promise<ConversationDebug> {
  const { conversationId, taskId, stage, expectedTurns } = options;
  const url = docUrlForStage(stage);
  const debug = await waitUntil(
    { label: `${stage}: document recorded from agent output` },
    async () => {
      const dump = await fetchConversationDebug(conversationId);
      const task = taskById(dump, taskId);
      const ready = artifactOf(dump, task.job_id)?.status === "ready";
      const inReview = task.status === "in_review";
      return ready && inReview && countTurns(dump) >= expectedTurns ? dump : null;
    },
  );
  const artifact = artifactOf(debug, taskById(debug, taskId).job_id)!;
  assertEqual(artifact.external_url, url, `${stage}: artifact url`);
  assertEqual(artifact.kind, "page", `${stage}: artifact kind`);
  assertEqual(artifact.status, "ready", `${stage}: artifact status`);
  assertEqual(taskById(debug, taskId).status, "in_review", `${stage}: task status`);
  assertEqual(countTurns(debug), expectedTurns, `${stage}: one harness turn per stage so far`);
  await assertDocumentAnnounced({ conversationId, stage, url, pageId: notionPageId(stage) });
  return debug;
}

/**
 * Checks what the page review of the reviewed stage posted on the document host. The humans hear
 * about the page once, and only after the loop closed.
 */
async function assertPageReviewPosted(
  conversationId: string,
  taskId: string,
  stage: string,
): Promise<void> {
  const debug = await fetchConversationDebug(conversationId);
  const jobId = taskById(debug, taskId).job_id;
  const onPage = (await fetchMockNotionComments()).filter(
    (comment) => comment.page_id === notionPageId(stage),
  );
  const inline = onPage.find((comment) => comment.block_id !== null);
  assert(
    inline?.text.includes("Reviewer: "),
    `${stage}: the inline finding carries the reviewer's signature`,
    onPage,
  );
  const outcome = onPage.find((comment) => comment.block_id === null);
  assert(
    outcome?.text.includes("1 finding is on the block it quotes."),
    `${stage}: the outcome comment counts the inline finding`,
    onPage,
  );

  assert(
    hasLogLine(debug, "holding the announcement until the review settles"),
    `${stage}: the page was held back until the review settled`,
    debug.log.slice(-8),
  );
  assertEqual(countLogLines(debug, handedOverLine(jobId)), 1, `${stage}: one handover`);
  const announcements = debug.outbox.filter(
    (message) =>
      message.channel === "tracker" &&
      message.kind === "response" &&
      outboxText(message).includes(docUrlForStage(stage)),
  );
  assertEqual(announcements.length, 1, `${stage}: the humans hear about the page once`);
  assertEqual(
    outboxText(announcements[0]!),
    [
      `The document is ready for you: ${docUrlForStage(stage)}`,
      "Comment on the page. Your comments wait until a comment mentions @artfct. Then the author gets them all and revises. You can also ask for that in this thread.",
    ].join("\n"),
    `${stage}: the announcement is the handover the page kind wrote`,
  );
}

/** Asks for status on the Linear session and checks it names the plan and the running task. */
async function assertStatusNamesStage(conversationId: string, stage: string): Promise<void> {
  const before = await fetchConversationDebug(conversationId);
  const replies = countOutboxMessages(before, isStatusReply);
  const turns = countTurns(before);
  await replyOnLinear("status?");
  const debug = await waitUntil({ label: `${stage}: status posted to Linear` }, async () => {
    const dump = await fetchConversationDebug(conversationId);
    return countOutboxMessages(dump, isStatusReply) > replies ? dump : null;
  });
  const text = outboxText(debug.outbox.filter(isStatusReply).at(-1)!);
  assert(
    text.includes(`Workflow ${conversationId}: running`),
    `${stage}: status names the workflow and its state`,
    text,
  );
  assert(
    text.includes(`Plan: ${STAGE_NAMES.join(" -> ")}`),
    `${stage}: status names the plan`,
    text,
  );
  assert(text.includes(`[${stage}]:`), `${stage}: status names the running task's stage`, text);
  assertEqual(countTurns(debug), turns, `${stage}: status query did not prompt the harness`);
}

/**
 * Completes the job of a stage with a Linear reply, which the scripted model judges. Returns the
 * next stage's task that starts in a sandbox, once its first harness turn has ended.
 */
async function completeAndAdvance(options: {
  conversationId: string;
  taskId: string;
  stage: string;
  next: string;
  reply: string;
}): Promise<DebugTask> {
  const { conversationId, taskId, stage, next, reply } = options;
  const baseline = await turnBaseline(conversationId);

  await replyOnLinear(reply);
  const advanced = await waitUntil(
    { label: `${stage}: completed and advanced to ${next}` },
    async () => {
      const dump = await fetchConversationDebug(conversationId);
      const done = taskById(dump, taskId).status === "done";
      const provisioned = (sandboxedTaskOf(dump, next)?.sandbox?.generation ?? 0) > 0;
      return done && provisioned ? dump : null;
    },
  );
  assertEqual(taskById(advanced, taskId).status, "done", `${stage}: task done`);
  assert(
    countTaskLogLines(advanced, taskId, "done:") > 0,
    `${stage}: completion logged`,
    advanced.log.slice(-6),
  );
  if (stage !== MODEL_DOC_STAGE) {
    const exit = await waitForSandboxDestroyed(taskId, `${stage}: sandbox destroyed`);
    if (exit) assert(exit.code === 0 || exit.killed, `${stage}: bridge exited cleanly`, exit);
  }

  const nextTask = sandboxedTaskOf(advanced, next)!;
  const nextTaskId = nextTask.task_id;
  const branch = DOC_STAGES.includes(next)
    ? null
    : `${ORCHESTRATOR_BRANCH_PREFIX}${nextTask.job_id}-${TITLE_SLUG}`;
  assertEqual(jobById(advanced, nextTask.job_id).branch, branch, `${next}: job branch`);

  const provisioned = await waitUntil(
    { label: `${next}: task provisioned and bridge said hello` },
    async () => {
      const dump = await fetchConversationDebug(conversationId);
      return countTaskLogLines(dump, nextTaskId, "hello fresh=true") === 1 ? dump : null;
    },
  );
  assertEqual(taskById(provisioned, nextTaskId).sandbox?.generation, 1, `${next}: task generation`);
  await assertStartsSince(0, 1, `${next}: mock sandbox saw one start`, nextTaskId);
  await assertStartSpec({ conversationId, taskId: nextTaskId, stage: next, branch, generation: 1 });
  await waitForTurns({
    conversationId,
    baseline,
    expected: 1,
    label: `${next}: first harness turn ended`,
  });
  return nextTask;
}

/** Checks the researcher of the model stage. Returns the job id. */
async function assertResearchStored(conversationId: string, researcherId: string): Promise<string> {
  const stage = MODEL_DOC_STAGE;
  const debug = await waitUntil({ label: `${stage}: research payload stored` }, async () => {
    const dump = await fetchConversationDebug(conversationId);
    return taskById(dump, researcherId).status === "done" ? dump : null;
  });
  const jobId = taskById(debug, researcherId).job_id;
  assertEqual(
    jobById(debug, jobId).research_payload,
    mockResearchPayload(stage),
    `${stage}: the job holds the payload the researcher wrote in its container`,
  );
  assert(
    hasLogLine(debug, "research payload stored"),
    `${stage}: the payload store is logged`,
    debug.log.slice(-8),
  );
  await waitForSandboxDestroyed(researcherId, `${stage}: researcher sandbox destroyed`);
  return jobId;
}

/** Waits for the page the model-call author created and checks what the document host received. */
async function assertModelAuthorPage(conversationId: string, jobId: string): Promise<DebugTask> {
  const stage = MODEL_DOC_STAGE;
  const debug = await waitUntil(
    { label: `${stage}: the model call created the page` },
    async () => {
      const dump = await fetchConversationDebug(conversationId);
      return artifactOf(dump, jobId)?.status === "ready" ? dump : null;
    },
  );
  const author = authorTaskOf(debug, stage)!;
  assertEqual(author.sandbox, null, `${stage}: the model-call author has no sandbox`);
  assertEqual(author.status, "in_review", `${stage}: author status`);
  await assertStartsSince(0, 0, `${stage}: the author started no sandbox`, author.task_id);

  const pages = await fetchMockNotionPages();
  assertEqual(pages.length, 1, `${stage}: the document host created one page`);
  const page = pages[0]!;
  assertEqual(
    page.parent_id,
    PAGE_PARENT_ID,
    `${stage}: the page is under the page parent the plan named`,
  );
  assert(page.title.endsWith(` (${stage})`), `${stage}: the page title names the stage`, page);
  assertEqual(page.markdown_versions.length, 1, `${stage}: the page was written once`);
  const created = page.markdown_versions[0]!;
  assert(
    created.includes(mockResearchPayload(stage)),
    `${stage}: the model call read the research payload`,
    created,
  );
  assertEqual(
    parseDocumentOptions(created),
    SCRIPTED_AUTHOR_OPTIONS,
    `${stage}: the page lists the options under the options heading`,
  );

  const artifact = artifactOf(debug, jobId)!;
  assertEqual(artifact.kind, "page", `${stage}: artifact kind`);
  assert(artifact.external_url.endsWith(page.id), `${stage}: artifact url`, artifact);
  const url = artifact.external_url;
  await assertDocumentAnnounced({ conversationId, stage, url, pageId: page.id });
  return author;
}

/** The job of the model stage holds the selection, and the next stage's author worked from it. */
async function assertSelectionCarried(options: {
  conversationId: string;
  jobId: string;
  nextTaskId: string;
}): Promise<void> {
  const { conversationId, jobId, nextTaskId } = options;
  const debug = await fetchConversationDebug(conversationId);
  assertEqual(
    jobById(debug, jobId).selection,
    SELECTED_OPTION,
    `${MODEL_DOC_STAGE}: the job holds the selection`,
  );
  assert(
    hasLogLine(debug, `humans selected ${SELECTED_OPTION}: 1.00`),
    `${MODEL_DOC_STAGE}: the decisions model confirmed the selection`,
    debug.log.slice(-12),
  );
  const summary = taskById(debug, nextTaskId).summary;
  assert(
    summary.includes(`Worked from the selection: ${SELECTED_OPTION}.`),
    "the next stage's author read the selection in its prompt",
    summary,
  );
}

/** Runs the model stage from its researcher. Returns the next stage's task. */
async function runModelDocStage(conversationId: string, researcherId: string): Promise<DebugTask> {
  const stage = MODEL_DOC_STAGE;
  const next = STAGE_NAMES[STAGE_NAMES.indexOf(stage) + 1]!;
  const jobId = await assertResearchStored(conversationId, researcherId);
  const author = await assertModelAuthorPage(conversationId, jobId);
  await waitForHandoverRead(conversationId, jobId);
  assertEqual(
    countTurns(await fetchConversationDebug(conversationId)),
    authorTurnsThrough(stage),
    `${stage}: one harness turn per stage so far`,
  );
  await assertStatusNamesStage(conversationId, stage);
  const nextTask = await completeAndAdvance({
    conversationId,
    taskId: author.task_id,
    stage,
    next,
    reply: `go with ${SELECTED_OPTION}`,
  });
  await assertSelectionCarried({ conversationId, jobId, nextTaskId: nextTask.task_id });
  return nextTask;
}

/** Runs step 2 and returns the PR stage task and its branch. */
export async function runDocumentStages(
  options: DocumentStagesOptions,
): Promise<DocumentStagesResult> {
  const { conversationId } = options;
  console.log("\n2. Document stages");
  let task: DebugTask | null = null;
  let taskId = options.taskId;
  for (const [index, stage] of DOC_STAGES.entries()) {
    const next = STAGE_NAMES[index + 1]!;
    if (stage === MODEL_DOC_STAGE) {
      task = await runModelDocStage(conversationId, taskId);
      taskId = task.task_id;
      continue;
    }
    const expectedTurns = authorTurnsThrough(stage);
    const recorded = await assertDocumentRecorded({ conversationId, taskId, stage, expectedTurns });
    if (stage === REVIEWED_DOC_STAGE) await assertPageReviewPosted(conversationId, taskId, stage);
    await waitForHandoverRead(conversationId, taskById(recorded, taskId).job_id);
    await assertStatusNamesStage(conversationId, stage);
    task = await completeAndAdvance({ conversationId, taskId, stage, next, reply: ACCEPT_REPLY });
    taskId = task.task_id;
  }
  assert(task, "the PR stage has an author task", task);
  const { branch } = jobById(await fetchConversationDebug(conversationId), task.job_id);
  assert(branch, "the PR stage job has a branch", task);
  return { taskId, branch };
}
