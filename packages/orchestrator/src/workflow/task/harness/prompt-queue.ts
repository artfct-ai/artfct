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
import { startFollowUp } from "../../follow-up";
import { reviseModelAuthorPage } from "../model-author";
import { startSandbox } from "../sandbox/sandbox";
import { sendRequest } from "./bridge";
import type { WorkflowRuntime } from "../../types";
import { taskSettings } from "../settings";
import { isTaskFinished } from "../../store/state";
import type { SandboxRow, TaskRow } from "../../store/tasks";
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
  if (isTaskFinished(task.status)) return;
  const followUp = startFollowUp(workflow, task);
  workflow.store.enqueuePrompt(task.task_id, text);
  if (task.paused_at === null) await drainQueue(workflow, task);
  if (followUp) await flushBoards(workflow, task.job_id);
}

/**
 * Send the oldest queued prompt if the harness can take one. A bridge still handshaking sends
 * it itself. Without a bridge, wake the sandbox once the reconnect window has passed. An
 * author whose artifact a polisher holds waits like a paused one until the polisher ends.
 */
export async function drainQueue(workflow: WorkflowRuntime, task: TaskRow): Promise<boolean> {
  if (isTaskFinished(task.status) || task.paused_at !== null) return false;
  if (task.role === "author" && runningPolisherOf(workflow, task.job_id)) return false;
  if (taskSettings(workflow, task).execution === "model") {
    return reviseModelAuthorPage(workflow, task);
  }
  const sandbox = workflow.store.requireSandbox(task.task_id);
  if (sandbox.prompt_in_flight) return false;
  const next = workflow.store.peekPrompt(task.task_id);
  if (!next) return false;
  const connected = workflow.connections(task.task_id).length > 0;
  if (connected && sandbox.session_id) {
    workflow.store.dequeuePrompt(next.id);
    await sendPrompt(workflow, task, next.text);
    return true;
  }
  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {
    return false;
  }
  if (connected) return false;
  await wakeOrWait(workflow, task, sandbox);
  return false;
}

/**
 * The bridge is gone. A task that still has a harness session gets the reconnect window
 * first. One whose harness session went with its container has nothing to reconnect to, so its
 * sandbox starts again now.
 */
async function wakeOrWait(
  workflow: WorkflowRuntime,
  task: TaskRow,
  sandbox: SandboxRow,
): Promise<void> {
  const closedAt = sandbox.bridge_closed_at ? Date.parse(sandbox.bridge_closed_at) : null;
  const sinceClose = closedAt === null ? Infinity : workflow.now() - closedAt;
  if (sandbox.session_id && sinceClose < RECONNECT_CEILING_MS) {
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

/** Send `session/prompt`, mark the turn in flight, and arm the turn's timers. */
export async function sendPrompt(
  workflow: WorkflowRuntime,
  task: TaskRow,
  text: string,
): Promise<void> {
  const sessionId = workflow.store.requireSandbox(task.task_id).session_id;
  if (!sessionId) return;
  workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 1, turn_text: "" });
  if (task.status === "in_review") workflow.store.updateTask(task.task_id, { status: "working" });
  const params: PromptRequest = { sessionId, prompt: [{ type: "text", text }] };
  sendRequest(workflow, task, AgentMethods.sessionPrompt, params, "prompt");
  await armNoProgress(workflow, workflow.store.requireSandbox(task.task_id));
  await armWallClock(workflow, workflow.store.requireSandbox(task.task_id));
  await armKeepAlive(workflow, workflow.store.requireSandbox(task.task_id));
}

/** Send the first prompt of a harness session that finished its handshake. */
export function sendFirstPrompt(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  return sendPrompt(workflow, task, firstPromptText(workflow, task));
}

/** First prompt of a fresh harness session, or the resume prompt on a later generation. */
export function firstPromptText(workflow: WorkflowRuntime, task: TaskRow): string {
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
  const resumes = sandbox.generation > 1 || sandbox.restarts > 0;
  if (!resumes) {
    return taskPrompt({ instructions, context: taskContext(workflow, task), artifact });
  }
  const pending = workflow.store.peekPrompt(task.task_id);
  if (pending) workflow.store.dequeuePrompt(pending.id);
  return resumePrompt({
    instructions,
    context: taskContext(workflow, task),
    artifact,
    artifactUrl: workflow.store.artifact(task.job_id)?.external_url ?? null,
    lastTurnTail: task.summary || null,
    wake: pending?.text ?? "Resume where you left off.",
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
  return reviewPrompt({ ...subject, signatureLine: reviewerSignature(workflow, entry, task) });
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
  };
}
