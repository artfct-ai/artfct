import type { Documents } from "@artfct-ai/adapters/docs/types";
import type { Effort } from "@artfct-ai/adapters/harness/types";
import type { JSONValue, LanguageModel } from "ai";
import { aboveResources, splitAtResources } from "../../artifact/resources-section";
import type { ArtifactTarget } from "../../artifact/types";
import { noteMessage } from "../../agent/transcript/envelope";
import { stepsUsage } from "../../agent/model/usage";
import { registeredConfig } from "../../config/register-config";
import { skillPromptText } from "../../config/skills";
import type { TaskSettings } from "../../config/stage";
import {
  producePagePrompt,
  revisePrompt,
  splitReviseAnswer,
  type ModelAuthorSubject,
} from "../../prompts/model-author-prompt";
import { markAuthorInReview, recordArtifact, stageHasRefiners } from "../artifact";
import { flushBoards } from "../board/board";
import { failTask } from "../lifecycle";
import { heldForReview, settleRefinersForAuthor } from "../refiner/loop";
import { newPageParent } from "../root-page";
import { markArtifactReady, reopenChangedArtifact } from "../refiner/outcome";
import { isTaskFinished, workflowName } from "../store/state";
import type { JobRow, TaskRow } from "../store/tasks";
import type { Wake, WorkflowRuntime } from "../types";
import { drainQueue, taskContext } from "./harness/prompt-queue";
import { digestFor, LOGGED_ERROR_CHARS, loggedFailureReason, SUMMARY_CHARS } from "./harness/turn";

/** The title of the page a model-call author creates. */
export function modelAuthorPageTitle(name: string, stage: string): string {
  return `${name} (${stage})`;
}

/** The first turn of a model-call author: the produce activity. */
export async function runModelAuthorTurn(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  const docs = await workflow.docs();
  const parent = newPageParent(workflow.state);
  if (!docs || !parent) {
    return failTask(
      workflow,
      task,
      "A model-call author needs a document host and a page parent or a root page on the plan.",
    );
  }
  workflow.store.updateTask(task.task_id, { status: "working" });
  await flushBoards(workflow, task.job_id);
  const outcome = await producePage(workflow, task, { docs, parent }).catch((error: unknown) => {
    workflow.log(
      task.task_id,
      `model call or page create failed: ${String(error).slice(0, LOGGED_ERROR_CHARS)}`,
    );
    return { failure: loggedFailureReason(task.task_id, "The model call or the page create") };
  });
  if ("failure" in outcome) {
    return failTask(workflow, workflow.store.requireTask(task.task_id), outcome.failure);
  }
  if (outcome.target === null) return;
  await recordArtifact(workflow, workflow.store.requireTask(task.task_id), outcome.target);
  await resumeModelAuthor(workflow, task.task_id, "task_result", "");
}

/** A revise turn of a model-call author. True when it took a prompt. */
export async function reviseModelAuthorPage(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<boolean> {
  if (task.status !== "in_review") return false;
  const next = workflow.store.peekPrompt(task.task_id);
  if (!next) return false;
  workflow.store.dequeuePrompt(next.id);
  workflow.store.updateTask(task.task_id, { status: "working" });
  await flushBoards(workflow, task.job_id);
  const outcome = await revisePage(workflow, task, next.text).catch((error: unknown) => {
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
  if (outcome.closingText === null) return true;
  markAuthorInReview(workflow, task.task_id);
  await reopenChangedArtifact(workflow, task.job_id);
  await resumeModelAuthor(workflow, task.task_id, "task_idle", outcome.closingText);
  return true;
}

/** Handle a model-call author back in review after a turn that ended with `closingText`. */
async function resumeModelAuthor(
  workflow: WorkflowRuntime,
  taskId: string,
  wake: Wake,
  closingText: string,
): Promise<void> {
  const { job_id: jobId } = workflow.store.requireTask(taskId);
  await settleRefinersForAuthor(workflow, workflow.store.requireTask(taskId));
  if (await drainQueue(workflow, workflow.store.requireTask(taskId))) return;
  if (!stageHasRefiners(workflow.stageFor(workflow.store.requireJob(jobId)))) {
    await markArtifactReady(workflow, jobId, { close: "ready" });
  }
  await flushBoards(workflow, jobId);
  const artifact = workflow.store.artifact(jobId);
  if (artifact && heldForReview(workflow, artifact)) return;
  const digest = await digestFor(workflow, taskId, closingText);
  await workflow.tellAgent(noteMessage(`Model call ended.\n${digest}`), wake);
}

/** Where the page goes. */
type PageHost = { docs: Documents; parent: string };

/**
 * Produce the page and create it on the host. The root page stage fills the root page the
 * workflow created for it instead. A null target means the task finished first.
 */
async function producePage(
  workflow: WorkflowRuntime,
  task: TaskRow,
  host: PageHost,
): Promise<{ target: ArtifactTarget | null } | { failure: string }> {
  const job = workflow.store.requireJob(task.job_id);
  const call = await produceCall(workflow, task, await inputPageText(workflow, host.docs, job));
  const text = await callAuthorModel(workflow, task, {
    model: call.model,
    system: call.system,
    prompt: producePagePrompt(call.subject),
  });
  if (text === null) return { target: null };
  if (!text) return { failure: "The model answered with no document text." };
  const stage = workflow.stageForTask(task);
  const root = workflow.state.root_page;
  if (stage.root_page && root?.source === "container") {
    const filled = aboveResources(text, await host.docs.readPageContent(root.page_id));
    await host.docs.updatePageContent(root.page_id, filled);
    workflow.log(task.task_id, `root page filled: ${root.url}`);
    return { target: { url: root.url, ref: { kind: "page", page_id: root.page_id } } };
  }
  const title = modelAuthorPageTitle(workflowName(workflow.state), stage.name);
  const page = await host.docs.createPage(title, text, host.parent);
  workflow.log(task.task_id, `page created: ${page.url}`);
  return { target: { url: page.url, ref: { kind: "page", page_id: page.contentId ?? page.id } } };
}

/**
 * Revise the page in place with the revise activity, on its current text and the findings, and
 * keep the closing text as the task summary. On the root page the author sees and replaces only
 * the text above the resources section. A null closing text means the task finished first.
 */
async function revisePage(
  workflow: WorkflowRuntime,
  task: TaskRow,
  findings: string,
): Promise<{ closingText: string | null } | { failure: string }> {
  const docs = await workflow.docs();
  const ref = workflow.store.artifact(task.job_id)?.ref;
  if (!docs || ref?.kind !== "page") {
    return { failure: "A model-call author revises only a page on the document host." };
  }
  const job = workflow.store.requireJob(task.job_id);
  const { revise } = workflow.stageForTask(task).author;
  const isRootPage = ref.page_id === workflow.state.root_page?.page_id;
  const pageText = await docs.readPageContent(ref.page_id);
  const prompt = revisePrompt({
    context: taskContext(workflow, task),
    inputPageText: await inputPageText(workflow, docs, job),
    findings,
    pageText: isRootPage ? splitAtResources(pageText).body : pageText,
  });
  const text = await callAuthorModel(workflow, task, {
    model: await activityModel(workflow, revise.model, revise.effort),
    system: modelSystemPrompt(revise),
    prompt,
  });
  if (text === null) return { closingText: null };
  const revision = splitReviseAnswer(text);
  if (!revision) return { failure: "The model answered with no closing text." };
  if (!revision.pageText) return { failure: "The model answered with no document text." };
  const revised = isRootPage
    ? aboveResources(revision.pageText, await docs.readPageContent(ref.page_id))
    : revision.pageText;
  await docs.updatePageContent(ref.page_id, revised);
  workflow.store.updateTask(task.task_id, { summary: revision.closingText.slice(-SUMMARY_CHARS) });
  workflow.log(task.task_id, `page updated: ${ref.page_id}`);
  return { closingText: revision.closingText };
}

/** One gateway call, counted on the task. Null when the task finished first. */
async function callAuthorModel(
  workflow: WorkflowRuntime,
  task: TaskRow,
  request: { model: LanguageModel; system: string; prompt: string },
): Promise<string | null> {
  const { generateText } = await import("ai");
  const result = await generateText(request);
  const { cost_usd } = stepsUsage(result.steps);
  const counted = workflow.store.requireTask(task.task_id);
  workflow.store.updateTask(task.task_id, { cost_usd: counted.cost_usd + cost_usd });
  if (isTaskFinished(counted.status)) {
    workflow.log(task.task_id, `model call ended after the task was ${counted.status}. no change.`);
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
  docs: Documents,
  job: JobRow,
): Promise<string | null> {
  if (job.input_ref?.kind === "page") return docs.readPageContent(job.input_ref.page_id);
  if (!job.preceding_job_id) return null;
  const artifact = workflow.store.artifact(job.preceding_job_id);
  if (artifact?.ref.kind !== "page") return null;
  return docs.readPageContent(artifact.ref.page_id);
}
