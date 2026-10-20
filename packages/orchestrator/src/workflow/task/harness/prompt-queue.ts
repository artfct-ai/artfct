import type { PromptRequest } from "@agentclientprotocol/sdk";
import { AgentMethods } from "@artfct-ai/acp/methods";
import type { HarnessAdapter } from "@artfct-ai/adapters/harness/types";
import { polishPrompt } from "../../../prompts/polish-prompt";
import { researcherTaskPrompt } from "../../../prompts/researcher-prompt";
import { judgePrompt, reviewPrompt } from "../../../prompts/review-prompt";
import { stageContinuesArtifact } from "../../artifact";
import { resumePrompt, taskPrompt, type TaskContext } from "../../../prompts/task-prompt";
import {
  refinerIndexOf,
  refinerAt,
  reviewerEntryOf,
  reviewerSignature,
  runningPolisherOf,
} from "../../refiner/stage-refiner";
import { flushBoards } from "../../board/board";
import { startSessionFeedTurn } from "../../feed/feed";
import { newPageParent } from "../../root-page";
import { startFollowUp } from "../../follow-up";
import { drainModelAuthor } from "../model-author";
import { startSandbox } from "../sandbox/sandbox";
import { bridgeProcessGone, sendRequest } from "./bridge";
import { steerWaitingInstructions } from "./steer";
import type { WorkflowRuntime } from "../../types";
import { taskSettings } from "../settings";
import { isTaskFinished } from "../../store/state";
import type { QueuedPrompt, SandboxRow, TaskRow } from "../../store/tasks";
import { armKeepAlive, armNoProgress, armWallClock, type GenerationAlarm } from "./timers";

/** The bridge's reconnect backoff ceiling. Mirrors `MAX_DELAY_MS` in packages/bridge/src/backoff.ts. */
export const RECONNECT_CEILING_MS = 30_000;

/**
 * Queue a prompt. It is sent at once when the harness is idle and connected. A prompt that
 * starts a follow-up posts the new board right away.
 */
export async function promptTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  text: string,
): Promise<void> {
  await queuePrompt(workflow, task, () => workflow.store.enqueuePrompt(task.task_id, text));
}

/**
 * Queue a person's instruction. A running turn of a harness that steers gets it at once. Otherwise
 * it goes as a prompt the way `promptTask` sends one.
 */
export async function instructTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  text: string,
): Promise<void> {
  await queuePrompt(workflow, task, () => workflow.store.enqueueInstruction(task.task_id, text));
}

async function queuePrompt(
  workflow: WorkflowRuntime,
  task: TaskRow,
  enqueue: () => void,
): Promise<void> {
  if (isTaskFinished(task.status)) return;
  const followUp = startFollowUp(workflow, task);
  enqueue();
  if (task.paused_at === null) await drainQueue(workflow, task);
  if (followUp) await flushBoards(workflow, task.job_id);
}

/**
 * True while the task's prompts wait: it is paused, or it is an author whose artifact a polisher
 * holds, until the polisher ends.
 */
function promptsWait(workflow: WorkflowRuntime, task: TaskRow): boolean {
  if (task.paused_at !== null) return true;
  return task.role === "author" && runningPolisherOf(workflow, task.job_id) !== null;
}

/**
 * Send the oldest queued prompt if the harness can take one, or steer waiting instructions into
 * the running turn. A bridge still handshaking sends it itself. Without a bridge, wake the sandbox
 * once the reconnect window has passed.
 */
export async function drainQueue(workflow: WorkflowRuntime, task: TaskRow): Promise<boolean> {
  if (isTaskFinished(task.status) || promptsWait(workflow, task)) return false;
  if (taskSettings(workflow, task).execution === "model") {
    return drainModelAuthor(workflow, task);
  }
  const sandbox = workflow.store.requireSandbox(task.task_id);
  if (sandbox.prompt_in_flight) {
    steerWaitingInstructions(workflow, task);
    return false;
  }
  const next = workflow.store.peekPrompt(task.task_id);
  if (!next) return false;
  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {
    return false;
  }
  const connected = workflow.connections(task.task_id).length > 0;
  if (connected && sandbox.session_id) {
    await sendPrompt(workflow, task, { text: next.text, queued: next });
    return true;
  }
  if (connected) return false;
  await wakeOrWait(workflow, task, sandbox);
  return false;
}

/**
 * The bridge is gone. A task that still has a harness session gets the reconnect window
 * first, while its bridge process still runs. One whose harness session or bridge process went
 * with its container has nothing to reconnect to, so its sandbox starts again now.
 */
async function wakeOrWait(
  workflow: WorkflowRuntime,
  task: TaskRow,
  sandbox: SandboxRow,
): Promise<void> {
  const closedAt = sandbox.bridge_closed_at ? Date.parse(sandbox.bridge_closed_at) : null;
  const sinceClose = closedAt === null ? Infinity : workflow.now() - closedAt;
  if (
    sandbox.session_id &&
    sinceClose < RECONNECT_CEILING_MS &&
    !(await bridgeProcessGone(workflow, task, sandbox.generation))
  ) {
    workflow.log(task.task_id, "bridge disconnected recently. waiting for it to reconnect.");
    const seconds = Math.ceil((RECONNECT_CEILING_MS - sinceClose) / 1000) + 1;
    await workflow.scheduleAlarm(seconds, "retryQueue", {
      task_id: task.task_id,
      generation: sandbox.generation,
    });
    return;
  }
  workflow.log(task.task_id, "no bridge connection. waking sandbox.");
  await startSandbox(workflow, task, true);
}

/** Alarm: a prompt waited for a reconnect. Send it, or restart the sandbox if the bridge is gone. */
export async function retryQueue(workflow: WorkflowRuntime, alarm: GenerationAlarm): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const sandbox = workflow.store.sandbox(alarm.task_id);
  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;
  await drainQueue(workflow, task);
}

/**
 * A prompt to send, and the queued prompt it carries. A carried instruction stays queued as taken
 * until the turn ends, and any other carried prompt leaves the queue.
 */
export type OutgoingPrompt = { text: string; queued: QueuedPrompt | null };

/**
 * Send `session/prompt`, mark the turn in flight, steer the instructions that still wait, and arm
 * the turn's timers and its session feed's tick.
 */
export async function sendPrompt(
  workflow: WorkflowRuntime,
  task: TaskRow,
  prompt: OutgoingPrompt,
): Promise<void> {
  const sessionId = workflow.store.requireSandbox(task.task_id).session_id;
  if (!sessionId) return;
  workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 1, turn_text: "" });
  if (task.status === "in_review") workflow.store.updateTask(task.task_id, { status: "working" });
  const params: PromptRequest = { sessionId, prompt: [{ type: "text", text: prompt.text }] };
  const rpcId = sendRequest(workflow, task, AgentMethods.sessionPrompt, params, "prompt");
  const { queued } = prompt;
  if (queued?.instruction) workflow.store.holdTakenPrompt(queued.id, rpcId);
  else if (queued) workflow.store.dequeuePrompt(queued.id);
  steerWaitingInstructions(workflow, task);
  await armNoProgress(workflow, workflow.store.requireSandbox(task.task_id));
  await armWallClock(workflow, workflow.store.requireSandbox(task.task_id));
  await armKeepAlive(workflow, workflow.store.requireSandbox(task.task_id));
  await startSessionFeedTurn(workflow, task);
}

/**
 * Send the first prompt of a harness session that finished its handshake. An author that resumes
 * wakes with the oldest waiting prompt. A task whose prompts wait holds the first prompt at the
 * head of its queue, so the next drain sends it before the prompts that waited.
 */
export async function sendFirstPrompt(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  const sandbox = workflow.store.requireSandbox(task.task_id);
  const waits = promptsWait(workflow, task);
  const resumes = task.role === "author" && sandbox.first_prompt_at !== null;
  const wake = resumes && !waits ? workflow.store.peekPrompt(task.task_id) : null;
  const text = firstPromptText(workflow, task, wake?.text ?? null);
  if (sandbox.first_prompt_at === null) {
    workflow.store.updateSandbox(task.task_id, {
      first_prompt_at: new Date(workflow.now()).toISOString(),
    });
  }
  if (!waits) return sendPrompt(workflow, task, { text, queued: wake });
  workflow.store.enqueuePromptFirst(task.task_id, text);
}

/**
 * The task prompt of a task without an earlier first prompt, else the resume prompt that wakes
 * the author with `wake`.
 */
export function firstPromptText(
  workflow: WorkflowRuntime,
  task: TaskRow,
  wake: string | null,
): string {
  const sandbox = workflow.store.requireSandbox(task.task_id);
  const harness = workflow.harness(sandbox.harness);
  if (task.role === "reviewer") return reviewerFirstPrompt(workflow, task, harness);
  if (task.role === "polisher") return polisherFirstPrompt(workflow, task, harness);
  if (task.role === "researcher") {
    const instructions = harness.invokeSkill(taskSettings(workflow, task).skill);
    return researcherTaskPrompt({ instructions, context: taskContext(workflow, task) });
  }
  const artifact = workflow.artifact(workflow.stageForTask(task).artifact).instructions;
  const instructions = harness.invokeSkill(taskSettings(workflow, task).skill);
  if (sandbox.first_prompt_at === null) {
    return taskPrompt({ instructions, context: taskContext(workflow, task), artifact });
  }
  return resumePrompt({
    instructions,
    context: taskContext(workflow, task),
    artifact,
    artifactUrl: workflow.store.artifact(task.job_id)?.external_url ?? null,
    lastTurnTail: task.summary || null,
    wake: wake ?? "Resume where you left off.",
  });
}

/** The reviewer run's prompt: the request and the brief of its job. */
function reviewerFirstPrompt(
  workflow: WorkflowRuntime,
  task: TaskRow,
  harness: HarnessAdapter,
): string {
  const job = workflow.store.requireJob(task.job_id);
  const artifact = workflow.store.artifact(job.job_id);
  const kind = artifact ? workflow.artifact(artifact.kind) : null;
  const entry = reviewerEntryOf(workflow, task);
  if (!artifact || !kind?.review || !entry) {
    return "The artifact or the reviewer entry you were started for is gone. Say so in one line and stop.";
  }
  const subject = {
    url: artifact.external_url,
    title: workflow.state.request.title,
    request: workflow.state.request.text,
    brief: job.brief,
    entryInstructions: harness.invokeSkill(entry.skill),
    artifact: kind.instructions,
    earlierArtifacts: taskContext(workflow, task).previous_artifacts,
    researchPayload: job.research_payload,
  };
  if (entry.mode === "judge") return judgePrompt(subject);
  const signatureLine = kind.review.reviewerPosts ? reviewerSignature(workflow, entry, task) : null;
  return reviewPrompt({ ...subject, signatureLine });
}

/** The prompt of a polisher run: the instructions of its entry, and how its artifact is read and changed. */
function polisherFirstPrompt(
  workflow: WorkflowRuntime,
  task: TaskRow,
  harness: HarnessAdapter,
): string {
  const job = workflow.store.requireJob(task.job_id);
  const artifact = workflow.store.artifact(job.job_id);
  const refiner = refinerAt(workflow.stageFor(job), refinerIndexOf(task));
  const { repo } = workflow.state;
  const kind = artifact ? workflow.artifact(artifact.kind) : null;
  if (!artifact || !kind || refiner?.role !== "polisher") {
    return "The artifact or the polisher entry you were started for is gone. Say so in one line and stop.";
  }
  return polishPrompt({
    url: artifact.external_url,
    title: workflow.state.request.title,
    request: workflow.state.request.text,
    brief: job.brief,
    instructions: harness.invokeSkill(refiner.entry.skill),
    repo: repo ? { full: repo.full, notes: kind.repositoryInstructions() } : null,
    branch: job.branch,
    artifact: kind.instructions,
  });
}

/** What a task reads about its job. */
export function taskContext(workflow: WorkflowRuntime, task: TaskRow): TaskContext {
  const { request, repo } = workflow.state;
  const job = workflow.store.requireJob(task.job_id);
  const kind = workflow.artifact(workflow.stageFor(job).artifact);
  const precedingJob = job.preceding_job_id
    ? workflow.store.requireJob(job.preceding_job_id)
    : null;
  return {
    brief: job.brief,
    title: request.title,
    text: request.text,
    links: request.links,
    repo: repo ? { full: repo.full, notes: kind.repositoryInstructions() } : null,
    branch: job.branch,
    previous_artifacts: workflow.store.previousArtifacts(job.job_id).map((artifact) => ({
      stage: artifact.stage,
      kind: artifact.kind,
      url: artifact.external_url,
    })),
    input_artifact:
      job.input_ref && job.input_url
        ? {
            kind: job.input_ref.kind,
            url: job.input_url,
            continued: stageContinuesArtifact(workflow.stageFor(job), job.input_ref),
          }
        : null,
    research_payload: job.research_payload,
    preceding_research_payload: precedingJob?.research_payload ?? null,
    preceding_selection: precedingJob?.selection ?? null,
    ending: workflow.stageFor(job).ending,
    page_parent: workflow.stageFor(job).artifact === "page" ? newPageParent(workflow.state) : null,
  };
}
