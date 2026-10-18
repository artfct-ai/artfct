import type { Documents, PageTextChange } from "@artfct-ai/adapters/documents/types";
import type { Effort } from "@artfct-ai/adapters/harness/types";
import type { JSONValue, LanguageModel } from "ai";
import { labeledPageCommentIds } from "../../artifact/page-comment-label";
import { aboveResources, splitAtResources } from "../../artifact/resources-section";
import type { ArtifactTarget } from "../../artifact/types";
import { noteMessage } from "../../agent/transcript/envelope";
import { stepsUsage } from "../../agent/model/usage";
import { runUnderDeadline } from "../../agent/turn/deadline";
import { registeredConfig } from "../../config/register-config";
import { skillPromptText } from "../../config/skills";
import type { TaskSettings } from "../../config/stage";
import {
  producePagePrompt,
  revisePrompt,
  splitReviseAnswer,
  validateCommentReplies,
  type ModelAuthorSubject,
} from "../../prompts/model-author-prompt";
import { markAuthorInReview, recordArtifact, stageHasRefiners } from "../artifact";
import { flushBoards } from "../board/board";
import { closeSessionFeed } from "../feed/feed";
import { failTask } from "../lifecycle";
import { heldForReview, settleRefinersForAuthor } from "../refiner/loop";
import { newPageParent, rootPageStage } from "../root-page";
import { markArtifactReady, reopenChangedArtifact } from "../refiner/outcome";
import { isTaskFinished, workflowName } from "../store/state";
import type { JobRow, TaskRow } from "../store/tasks";
import type { Wake, WorkflowRuntime } from "../types";
import { taskAtWork } from "./at-work";
import { startModelTurn } from "./model-turn";
import { drainQueue, taskContext } from "./harness/prompt-queue";
import { digestFor, LOGGED_ERROR_CHARS, loggedFailureReason, SUMMARY_CHARS } from "./harness/turn";

/**
 * Milliseconds one model call of a model-call author may take. The platform stops an alarm at
 * 15 minutes, so the call ends in time to fail its task and post the failure.
 */
const MODEL_AUTHOR_CALL_TIMEOUT_MS = 13 * 60_000;

/** The title of the page a model-call author creates. */
export function modelAuthorPageTitle(name: string, stage: string): string {
  return `${name} (${stage})`;
}

/** The first turn of a model-call author: the produce activity. */
export async function runModelAuthorTurn(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  const documents = await workflow.documents();
  const parent = newPageParent(workflow.state);
  if (!documents || !parent) {
    return failTask(
      workflow,
      task,
      "A model-call author needs a document host and a page parent or a root page on the plan.",
    );
  }
  const turn = await startModelTurn(workflow, task.task_id);
  await flushBoards(workflow, task.job_id);
  const outcome = await producePage(workflow, task, {
    documents,
    parent,
    turnEnded: turn.ended,
  }).catch((error: unknown) => {
    workflow.log(
      task.task_id,
      `model call or page create failed: ${String(error).slice(0, LOGGED_ERROR_CHARS)}`,
    );
    return { failure: loggedFailureReason(task.task_id, "The model call or the page create") };
  });
  if ("failure" in outcome) {
    return failTask(workflow, workflow.store.requireTask(task.task_id), outcome.failure);
  }
  if (outcome.target === null || finishedDuringPageWrite(workflow, task.task_id)) return;
  turn.finish();
  await recordArtifact(workflow, workflow.store.requireTask(task.task_id), outcome.target);
  await resumeModelAuthor(workflow, task.task_id, "task_result", "");
}

/**
 * Start the next turn of a model-call author that is not at work. True when it took a prompt.
 * An author whose page is not out yet, such as one a stop ended before its first turn, queues
 * to produce it, and takes the prompt once the page is out.
 */
export async function drainModelAuthor(workflow: WorkflowRuntime, task: TaskRow): Promise<boolean> {
  if (taskAtWork(workflow, task)) return false;
  if (workflow.store.artifact(task.job_id)) return reviseModelAuthorPage(workflow, task);
  workflow.store.updateTask(task.task_id, { status: "queued" });
  await flushBoards(workflow, task.job_id);
  await workflow.scheduleAlarm(0, "provision", { task_id: task.task_id });
  return false;
}

/** The reply to a comment a queued prompt carries, when a revision rewrites the block it is on. */
export const QUEUED_COMMENT_REPLY =
  "A revision that started before this comment arrived rewrites this part of the page. The author reads this comment next.";

/**
 * A revise turn of a model-call author. Its prompt stays queued until the revision is applied, so
 * a lost turn runs again on it. A turn on a page a person edited during the model call starts
 * over on the page as it is now. True when it took a prompt.
 */
async function reviseModelAuthorPage(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<boolean> {
  if (task.status !== "in_review") return false;
  const next = workflow.store.peekPrompt(task.task_id);
  if (!next) return false;
  const turn = await startModelTurn(workflow, task.task_id);
  await flushBoards(workflow, task.job_id);
  const outcome = await revisePage(workflow, task, {
    findings: next.text,
    promptId: next.id,
    turnEnded: turn.ended,
  }).catch((error: unknown) => {
    workflow.log(
      task.task_id,
      `model call or page update failed: ${String(error).slice(0, LOGGED_ERROR_CHARS)}`,
    );
    return { failure: loggedFailureReason(task.task_id, "The model call or the page update") };
  });
  if ("failure" in outcome) {
    await failTask(workflow, workflow.store.requireTask(task.task_id), outcome.failure);
    return true;
  }
  if ("startOver" in outcome) {
    workflow.log(task.task_id, "a person edited the page during the model call. starting over.");
    turn.finish();
    markAuthorInReview(workflow, task.task_id);
    return reviseModelAuthorPage(workflow, workflow.store.requireTask(task.task_id));
  }
  if (outcome.closingText === null || finishedDuringPageWrite(workflow, task.task_id)) return true;
  workflow.store.dequeuePrompt(next.id);
  turn.finish();
  markAuthorInReview(workflow, task.task_id);
  await reopenChangedArtifact(workflow, task.job_id);
  await resumeModelAuthor(workflow, task.task_id, "task_idle", outcome.closingText);
  return true;
}

/**
 * Handle a model-call author back in review after a turn that ended with `closingText`. An author
 * left idle ends its session feed with the reply.
 */
async function resumeModelAuthor(
  workflow: WorkflowRuntime,
  taskId: string,
  wake: Wake,
  closingText: string,
): Promise<void> {
  const { job_id: jobId } = workflow.store.requireTask(taskId);
  await settleRefinersForAuthor(workflow, workflow.store.requireTask(taskId));
  if (await drainQueue(workflow, workflow.store.requireTask(taskId))) return;
  await closeSessionFeed(workflow, workflow.store.requireTask(taskId), { kind: "reply" });
  if (!stageHasRefiners(workflow.stageFor(workflow.store.requireJob(jobId)))) {
    await markArtifactReady(workflow, jobId, { close: "ready" });
  }
  await flushBoards(workflow, jobId);
  const artifact = workflow.store.artifact(jobId);
  if (artifact && heldForReview(workflow, artifact)) return;
  const digest = await digestFor(workflow, taskId, closingText);
  await workflow.tellAgent(noteMessage(`Model call ended.\n${digest}`), wake);
}

/**
 * True when the task finished while the host wrote its page. The page does not become the
 * artifact of a finished task, so a cancelled job does not hold its input again.
 */
function finishedDuringPageWrite(workflow: WorkflowRuntime, taskId: string): boolean {
  const { status } = workflow.store.requireTask(taskId);
  if (!isTaskFinished(status)) return false;
  workflow.log(taskId, `page written after the task was ${status}. no change.`);
  return true;
}

/** Where the page goes, and whether a stop ended the turn. */
type PageHost = { documents: Documents; parent: string; turnEnded: () => boolean };

/**
 * Produce the page and create it on the host. The root page stage instead fills the root page
 * the plan created, and gives it the title its page would have. A null target means the task
 * finished first.
 */
async function producePage(
  workflow: WorkflowRuntime,
  task: TaskRow,
  host: PageHost,
): Promise<{ target: ArtifactTarget | null } | { failure: string }> {
  const job = workflow.store.requireJob(task.job_id);
  const call = await produceCall(
    workflow,
    task,
    await inputPageText(workflow, host.documents, job),
  );
  const text = await callAuthorModel(workflow, task, {
    model: call.model,
    system: call.system,
    prompt: producePagePrompt(call.subject),
    turnEnded: host.turnEnded,
  });
  if (text === null) return { target: null };
  if (!text) return { failure: "The model answered with no document text." };
  const stage = workflow.stageForTask(task);
  const title = modelAuthorPageTitle(workflowName(workflow.state), stage.name);
  const root = workflow.state.root_page;
  if (
    rootPageStage(workflow.workflowDefinition())?.name === stage.name &&
    root?.source === "container"
  ) {
    const before = await host.documents.readPageContent(root.page_id);
    const after = aboveResources(text, before);
    await host.documents.updatePageContent(root.page_id, { before, after });
    await host.documents.nesting?.renamePage(root.page_id, title);
    workflow.log(task.task_id, `root page filled: ${root.url}`);
    return { target: { url: root.url, ref: { kind: "page", page_id: root.page_id } } };
  }
  const page = await host.documents.createPage(title, text, host.parent);
  workflow.log(task.task_id, `page created: ${page.url}`);
  return { target: { url: page.url, ref: { kind: "page", page_id: page.contentId ?? page.id } } };
}

/**
 * Revise the page in place with the revise activity, on its current text and the findings, and
 * keep the closing text as the task summary. The author replies to each page comment the
 * findings label that is still on the page before the page changes, so a comment on a line the
 * revision rewrites already holds the answer. A comment another queued prompt carries gets a
 * reply too when the revision rewrites its line. Only the lines that changed are written. On the
 * root page the author sees and changes only the text above the resources section. A null
 * closing text means the task finished or a stop ended the turn first. `startOver` means a
 * person edited the page during the model call, and nothing was written.
 */
async function revisePage(
  workflow: WorkflowRuntime,
  task: TaskRow,
  turn: { findings: string; promptId: number; turnEnded: () => boolean },
): Promise<{ closingText: string | null } | { startOver: true } | { failure: string }> {
  const { findings, turnEnded } = turn;
  const documents = await workflow.documents();
  const ref = workflow.store.artifact(task.job_id)?.ref;
  if (!documents || ref?.kind !== "page") {
    return { failure: "A model-call author revises only a page on the document host." };
  }
  const job = workflow.store.requireJob(task.job_id);
  const { revise } = workflow.stageForTask(task).author;
  const isRootPage = ref.page_id === workflow.state.root_page?.page_id;
  const pageText = await documents.readPageContent(ref.page_id);
  const prompt = revisePrompt({
    context: taskContext(workflow, task),
    inputPageText: await inputPageText(workflow, documents, job),
    findings,
    pageText: isRootPage ? splitAtResources(pageText).body : pageText,
  });
  const text = await callAuthorModel(workflow, task, {
    model: await activityModel(workflow, revise.model, revise.effort),
    system: modelSystemPrompt(revise),
    prompt,
    turnEnded,
  });
  if (text === null) return { closingText: null };
  if ((await documents.readPageContent(ref.page_id)) !== pageText) return { startOver: true };
  const revision = splitReviseAnswer(text);
  if (!revision) return { failure: "The model answered with no closing text." };
  if (!revision.pageText) return { failure: "The model answered with no document text." };
  const unanswered = validateCommentReplies(findings, revision.replies);
  if (unanswered) return { failure: unanswered };
  for (const reply of revision.replies) {
    if (!(await documents.fetchComment(reply.comment_id))) {
      workflow.log(task.task_id, `comment ${reply.comment_id} is gone from the page. no reply.`);
      continue;
    }
    await documents.replyToComment(
      { pageId: ref.page_id, commentId: reply.comment_id },
      reply.text,
    );
  }
  const after = isRootPage ? aboveResources(revision.pageText, pageText) : revision.pageText;
  const change = { before: pageText, after };
  await replyToQueuedCommentsOnRemovedLines(workflow, task, {
    documents,
    pageId: ref.page_id,
    change,
    promptId: turn.promptId,
  });
  await documents.updatePageContent(ref.page_id, change);
  workflow.store.updateTask(task.task_id, { summary: revision.closingText.slice(-SUMMARY_CHARS) });
  workflow.log(
    task.task_id,
    `page updated: ${ref.page_id}, replied to ${revision.replies.length} comment(s)`,
  );
  return { closingText: revision.closingText };
}

/**
 * Reply to each comment that another queued prompt of the task carries, when writing `change`
 * would remove it. The author reads it only after this revision, so the reply says so.
 */
async function replyToQueuedCommentsOnRemovedLines(
  workflow: WorkflowRuntime,
  task: TaskRow,
  write: { documents: Documents; pageId: string; change: PageTextChange; promptId: number },
): Promise<void> {
  const queuedCommentIds = workflow.store
    .queue()
    .filter((row) => row.task_id === task.task_id && row.id !== write.promptId)
    .flatMap((row) => labeledPageCommentIds(row.text));
  if (!queuedCommentIds.length) return;
  const removed = await write.documents.commentsOnRemovedLines(
    write.pageId,
    write.change,
    queuedCommentIds,
  );
  for (const commentId of removed) {
    await write.documents.replyToComment({ pageId: write.pageId, commentId }, QUEUED_COMMENT_REPLY);
  }
  if (removed.length) {
    workflow.log(
      task.task_id,
      `replied to ${removed.length} queued comment(s) the revision removes`,
    );
  }
}

/**
 * One gateway call, counted on the task. Null when the task finished or a stop ended the turn
 * first, even when the call failed. Throws past `MODEL_AUTHOR_CALL_TIMEOUT_MS`.
 */
async function callAuthorModel(
  workflow: WorkflowRuntime,
  task: TaskRow,
  request: { model: LanguageModel; system: string; prompt: string; turnEnded: () => boolean },
): Promise<string | null> {
  const { generateText } = await import("ai");
  const { turnEnded, ...call } = request;
  const bounded = await runUnderDeadline(MODEL_AUTHOR_CALL_TIMEOUT_MS, (abortSignal) =>
    generateText({ ...call, abortSignal }),
  ).catch((error: unknown) => ({ kind: "failed" as const, error }));
  if (bounded.kind !== "done" && turnEnded()) {
    workflow.log(task.task_id, "model call failed after a stop ended its turn. no change.");
    return null;
  }
  if (bounded.kind === "failed") throw bounded.error;
  if (bounded.kind === "timed_out") {
    throw new Error(`the model call ran past ${MODEL_AUTHOR_CALL_TIMEOUT_MS} ms`);
  }
  const result = bounded.result;
  const { cost_usd } = stepsUsage(result.steps);
  const counted = workflow.store.requireTask(task.task_id);
  workflow.store.updateTask(task.task_id, { cost_usd: counted.cost_usd + cost_usd });
  if (isTaskFinished(counted.status)) {
    workflow.log(task.task_id, `model call ended after the task was ${counted.status}. no change.`);
    return null;
  }
  if (turnEnded()) {
    workflow.log(task.task_id, "model call ended after a stop ended its turn. no change.");
    return null;
  }
  return result.text.trim();
}

/** The produce activity of a model-call author, ready to call. */
export type ProduceCall = {
  model: LanguageModel;
  system: string;
  subject: ModelAuthorSubject;
};

/** The produce activity of a task, on the task's model. */
export async function produceCall(
  workflow: WorkflowRuntime,
  task: TaskRow,
  inputPage: string | null,
): Promise<ProduceCall> {
  const { produce } = workflow.stageForTask(task).author;
  return {
    model: await activityModel(workflow, task.model, produce.effort),
    system: modelSystemPrompt(produce),
    subject: { context: taskContext(workflow, task), inputPageText: inputPage },
  };
}

/** The skill text a model-call activity runs on, with its preloaded skills, then the writing rules. */
function modelSystemPrompt(activity: TaskSettings): string {
  if (activity.execution !== "model") {
    throw new Error(`${activity.skill} runs in a harness, not as a model call`);
  }
  const skills = skillPromptText(activity.skill, activity.preload_skills);
  return `${skills}\n\n${registeredConfig().writingRules}`;
}

/** The gateway model of an author activity, asked for its effort. */
function activityModel(
  workflow: WorkflowRuntime,
  model: string,
  effort: Effort | undefined,
): Promise<LanguageModel> {
  const params: Record<string, JSONValue> = effort ? { reasoning_effort: effort } : {};
  return workflow.model(model, params, workflow.config().adapters.gateway.provider);
}

/**
 * The text of the page the job works from: the page the request pointed at, or the page of the
 * job that produced its input artifact. Null when the job works from no page.
 */
async function inputPageText(
  workflow: WorkflowRuntime,
  documents: Documents,
  job: JobRow,
): Promise<string | null> {
  if (job.input_ref?.kind === "page") return documents.readPageContent(job.input_ref.page_id);
  if (!job.preceding_job_id) return null;
  const artifact = workflow.store.artifact(job.preceding_job_id);
  if (artifact?.ref.kind !== "page") return null;
  return documents.readPageContent(artifact.ref.page_id);
}
