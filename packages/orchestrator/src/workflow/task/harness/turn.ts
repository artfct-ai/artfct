import type { SessionNotification, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { JsonRpcError } from "@artfct-ai/acp/jsonrpc";
import { summarizeUpdate, toolActivity, updateText } from "@artfct-ai/acp/updates";
import { noteMessage } from "../../../agent/transcript/envelope";
import { DIGEST_TURN_TEXT_PROMPT } from "../../../prompts/summarization-prompt";
import { boardTask, flushBoards, markBoardDirty } from "../../board/board";
import { openEntryCount } from "../../board/render";
import type { DigestInput } from "../../board/types";
import { heldForReview, onReviewerFinished, settleRefinersForAuthor } from "../../refiner/loop";
import { settlePolisherTurn } from "../../refiner/polish";
import { clipHead, collapse, lastBudget, taskDigest } from "./digest";
import { restartOrFailTask, startAuthorAfterResearch } from "../../lifecycle";
import { RESEARCH_PAYLOAD_PATH, readResearchPayload } from "../sandbox/research-payload";
import { harnessGaveUp } from "../gave-up";
import { drainQueue, sendFirstPrompt } from "./prompt-queue";
import type { WorkflowRuntime, Wake } from "../../types";
import type { TaskRow } from "../../store/tasks";
import { isTaskFinished } from "../../store/state";
import {
  detectArtifact,
  detectArtifactAfterTurn,
  markAuthorInReview,
  stageHasRefiners,
} from "../../artifact";
import { markArtifactReady, reopenChangedArtifact } from "../../refiner/outcome";
import { sandboxRefOf } from "../sandbox/size";
import { touchProgress } from "./timers";
import { feedClosingOf, flushFeed, publishSessionPlan, recordFeedUpdate } from "../../feed/feed";

/** How much closing text `tasks.summary` keeps. */
export const SUMMARY_CHARS = 2000;
const GAVE_UP_CHARS = 300;

/** The wake text an author resumes with after it gave up and its sandbox started over. */
export const GAVE_UP_RESTART_TEXT =
  "Your last turn ended before the work was finished. You are in a fresh sandbox on the same branch. Work that was not committed and pushed is gone. Read the branch and your artifact, then finish the work. When something outside the repository blocks a step, say what blocks it and finish every other step.";

/** How much of an error text that code did not write the log of the task keeps. */
export const LOGGED_ERROR_CHARS = 4000;

/**
 * The reason the humans and the orchestrator agent get for a failure whose text code did not
 * write. It names what failed and the task whose log holds that text.
 */
export function loggedFailureReason(taskId: string, failed: string): string {
  return `${failed} failed. The details are in the logs of task ${taskId}.`;
}

/** The stop reasons of a turn that the harness did not finish. */
const UNFINISHED_STOPS: StopReason[] = ["max_tokens", "max_turn_requests", "refusal"];

/**
 * Stream text into the turn buffer, watch for artifacts, and keep the board's todo list and
 * the digest counters up to date.
 */
export async function onSessionUpdate(
  workflow: WorkflowRuntime,
  task: TaskRow,
  notice: SessionNotification,
): Promise<void> {
  const sandbox = workflow.store.requireSandbox(task.task_id);
  await touchProgress(workflow, sandbox);
  const update = notice.update;
  recordFeedUpdate(workflow, task, update);
  await flushFeed(workflow, task);
  const text = updateText(update);
  if (text) {
    workflow.store.appendTurnText(task.task_id, text);
    await detectArtifact(workflow, task, text);
    return;
  }
  const entries = workflow.harness(sandbox.harness).plan(update);
  if (entries) {
    const stored = workflow.store.setTodos(task.task_id, { entries });
    workflow.log(
      task.task_id,
      `todo list reported: ${openEntryCount({ entries })} of ${entries.length} open`,
    );
    await markBoardDirty(workflow, task.job_id);
    if (stored) await publishSessionPlan(workflow, task);
  }
  countToolActivity(workflow, task, update);
  const summary = summarizeUpdate(update);
  if (summary) await workflow.post({ type: "progress", task_id: task.task_id, text: summary });
  if (update.sessionUpdate === "usage_update" && update.cost) {
    workflow.store.updateTask(task.task_id, { cost_usd: update.cost.amount });
  }
}

function countToolActivity(workflow: WorkflowRuntime, task: TaskRow, update: SessionUpdate) {
  const activity = toolActivity(update);
  if (!activity) return;
  if (activity.kind === "call") workflow.store.countToolCall(task.task_id);
  else workflow.store.countToolFailure(task.task_id, activity.title);
}

/**
 * A refiner run's turn finished. The nudge cancels a silent turn and queues its own prompt, so a
 * cancelled turn with something queued sends that instead: the refiner is not over, and ending it
 * here would destroy its container along with work it never pushed. A turn the harness did not
 * finish fails the run, and so does turn text that says the refiner gave up.
 */
async function endRefinerTurn(
  workflow: WorkflowRuntime,
  task: TaskRow,
  stopReason: StopReason,
): Promise<void> {
  const run = workflow.store.requireTask(task.task_id);
  if (stopReason === "cancelled" && workflow.store.peekPrompt(run.task_id)) {
    await drainQueue(workflow, run);
    return;
  }
  if (isTaskFinished(run.status)) return;
  if (await restartIfTurnUnfinished(workflow, run, stopReason)) return;
  if (run.role === "polisher") return settlePolisherTurn(workflow, run);
  await onReviewerFinished(workflow, run);
}

/**
 * Restart a researcher or a refiner run that did not finish, or whose turn text says it gave up.
 * It fails once its restarts are used up. True when the turn did not finish.
 */
async function restartIfTurnUnfinished(
  workflow: WorkflowRuntime,
  run: TaskRow,
  stopReason: StopReason,
): Promise<boolean> {
  if (UNFINISHED_STOPS.includes(stopReason)) {
    const reason = `The turn ended on ${stopReason} before the work was complete.`;
    await restartOrFailTask(workflow, run, reason);
    return true;
  }
  if (!(await harnessGaveUp(workflow, run))) return false;
  const reason = `The ${run.role} gave up: ${clipHead(run.summary, GAVE_UP_CHARS)}`;
  await restartOrFailTask(workflow, run, reason);
  return true;
}

/** End a researcher turn appropriately for the `StopReason`. */
async function endResearcherTurn(
  workflow: WorkflowRuntime,
  task: TaskRow,
  stopReason: StopReason,
): Promise<void> {
  const researcher = workflow.store.requireTask(task.task_id);
  if (isTaskFinished(researcher.status)) return;
  const resumes =
    researcher.paused_at !== null || workflow.store.peekPrompt(researcher.task_id) !== null;
  if (stopReason === "cancelled" && resumes) {
    await drainQueue(workflow, researcher);
    return;
  }
  if (await restartIfTurnUnfinished(workflow, researcher, stopReason)) return;
  const read = await readResearchPayload(workflow.sandbox(), sandboxRefOf(researcher));
  if ("payload" in read) return startAuthorAfterResearch(workflow, researcher, read.payload);
  if ("failure" in read) return restartOrFailTask(workflow, researcher, read.failure);
  workflow.log(
    researcher.task_id,
    `research payload read failed: ${read.readError.slice(0, LOGGED_ERROR_CHARS)}`,
  );
  await restartOrFailTask(
    workflow,
    researcher,
    loggedFailureReason(
      researcher.task_id,
      `The read of the research payload at ${RESEARCH_PAYLOAD_PATH}`,
    ),
  );
}

/**
 * A turn finished. Keep a summary, find the artifact, flush the board, and send the next
 * queued prompt. The model wakes with a digest for a result or an idle harness. Closing text
 * that says the author gave up restarts the author.
 */
export async function onTurnEnd(
  workflow: WorkflowRuntime,
  task: TaskRow,
  stopReason: StopReason,
): Promise<void> {
  workflow.log(task.task_id, `turn ended: ${stopReason}`);
  const turnText = workflow.store.requireSandbox(task.task_id).turn_text;
  workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0, turn_text: "" });
  workflow.store.updateTask(task.task_id, { summary: turnText.slice(-SUMMARY_CHARS) });
  if (task.role === "researcher") return endResearcherTurn(workflow, task, stopReason);
  if (task.role !== "author") return endRefinerTurn(workflow, task, stopReason);
  const text = turnText.trim();
  const recordedNow = await findArtifact(workflow, task, text);
  if (stopReason === "end_turn" && (await authorGaveUp(workflow, task.task_id))) return;
  workflow.store.patchTodoRow(task.task_id, { note: null });
  const busy = await settleAndResumeAuthor(workflow, task.task_id);
  await flushFeed(workflow, task, busy ? null : feedClosingOf(stopReason));
  if (!busy) await announceReopenedDraft(workflow, task.job_id);
  const wake = wakeAfterTurn(workflow, task.job_id, recordedNow, busy);
  if (wake === "none") return;
  const digest = await digestFor(workflow, task.task_id, text);
  await workflow.tellAgent(noteMessage(`Harness turn ended (${stopReason}).\n${digest}`), wake);
  workflow.store.resetCounters(task.task_id);
}

/**
 * The author whose turn text says it gave up restarts and resumes with the gave-up wake text. It
 * fails once its restarts are used up. True when it gave up.
 */
async function authorGaveUp(workflow: WorkflowRuntime, taskId: string): Promise<boolean> {
  const author = workflow.store.requireTask(taskId);
  if (!(await harnessGaveUp(workflow, author))) return false;
  workflow.store.enqueuePrompt(taskId, GAVE_UP_RESTART_TEXT);
  const reason = `The author gave up: ${clipHead(author.summary, GAVE_UP_CHARS)}`;
  await restartOrFailTask(workflow, author, reason);
  return true;
}

/** A reopened artifact on a stage with no refiner goes back to the humans when the harness is idle. */
async function announceReopenedDraft(workflow: WorkflowRuntime, jobId: string): Promise<void> {
  if (stageHasRefiners(workflow.stageFor(workflow.store.requireJob(jobId)))) return;
  await markArtifactReady(workflow, jobId, { close: "ready" });
}

/**
 * The author harness went quiet. Settle its review, send what is queued, write the row and the
 * board. True when the harness is busy again.
 */
async function settleAndResumeAuthor(workflow: WorkflowRuntime, taskId: string): Promise<boolean> {
  const { job_id: jobId } = workflow.store.requireTask(taskId);
  await reopenChangedArtifact(workflow, jobId);
  await settleRefinersForAuthor(workflow, workflow.store.requireTask(taskId));
  const sent = await drainQueue(workflow, workflow.store.requireTask(taskId));
  const busy = sent || workflow.store.requireSandbox(taskId).prompt_in_flight === 1;
  if (!busy) markAuthorInReview(workflow, taskId);
  await flushBoards(workflow, jobId);
  return busy;
}

/**
 * Why the model is needed after this turn. An artifact the review holds and a busy harness
 * wake nobody. A result recorded now is a task result, anything else an idle harness.
 */
function wakeAfterTurn(
  workflow: WorkflowRuntime,
  jobId: string,
  recordedNow: boolean,
  busy: boolean,
): Wake {
  const artifact = workflow.store.artifact(jobId);
  if (artifact && heldForReview(workflow, artifact)) return "none";
  if (recordedNow) return "task_result";
  return busy ? "none" : "task_idle";
}

/**
 * The fixed-shape digest of a task, from stored records. Closing text that does not fit is
 * summarized by the model.
 */
export async function digestFor(
  workflow: WorkflowRuntime,
  taskId: string,
  last: string,
): Promise<string> {
  const input = digestInput(workflow, taskId, last);
  return taskDigest({ ...input, last: await lastText(workflow, input) });
}

/**
 * The `last` text the digest carries: the turn text when it fits the budget, else a
 * summarization of it cut to the budget.
 */
async function lastText(workflow: WorkflowRuntime, input: DigestInput): Promise<string | null> {
  const text = input.last ? collapse(input.last) : "";
  const budget = lastBudget(input);
  if (!text || budget <= 0 || text.length <= budget) return input.last;
  const { runPrompt } = await import("../../../agent/model/run-prompt");
  const shortened = await runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, text, {
    maxChars: budget,
  });
  return shortened ? clipHead(collapse(shortened), budget) : input.last;
}

function digestInput(workflow: WorkflowRuntime, taskId: string, last: string): DigestInput {
  const task = workflow.store.requireTask(taskId);
  const artifact = workflow.store.artifact(task.job_id);
  const todoRow = workflow.store.todoRow(taskId);
  return {
    task: { ...boardTask(workflow, task), cost_usd: task.cost_usd },
    artifact: artifact
      ? { kind: artifact.kind, external_url: artifact.external_url, status: artifact.status }
      : null,
    todos: todoRow?.todos ?? null,
    counters: {
      tool_calls: todoRow?.tool_calls ?? 0,
      tool_failures: todoRow?.tool_failures ?? 0,
      failed_tools: todoRow?.failed_tools ?? [],
    },
    last: last || null,
    note: todoRow?.note ?? null,
    now: workflow.now(),
  };
}

/** Look for the job's artifact in the turn text and on the host. True when one was recorded now. */
async function findArtifact(
  workflow: WorkflowRuntime,
  task: TaskRow,
  text: string,
): Promise<boolean> {
  if (workflow.store.artifact(task.job_id) !== null) return false;
  return detectArtifactAfterTurn(workflow, task, text);
}

/** A researcher or a refiner run whose only prompt errored. Send what is queued behind it, else restart it. */
async function endBrokenRun(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  const queued = workflow.store.peekPrompt(task.task_id) !== null;
  await drainQueue(workflow, workflow.store.requireTask(task.task_id));
  if (queued) return;
  await restartOrFailTask(workflow, workflow.store.requireTask(task.task_id), reason);
}

/**
 * An rpc the harness refused. A failed prompt gets no turn end, so the author settles here
 * the way a turn end would.
 */
export async function onRpcError(
  workflow: WorkflowRuntime,
  task: TaskRow,
  purpose: string,
  method: string,
  error: JsonRpcError,
): Promise<void> {
  workflow.log(
    task.task_id,
    `${method} error ${error.code}: ${error.message.slice(0, LOGGED_ERROR_CHARS)}`,
  );
  if (purpose === "initialize" || purpose === "session_new") {
    const reason = loggedFailureReason(task.task_id, `The harness request ${method}`);
    return restartOrFailTask(workflow, task, reason);
  }
  if (purpose === "set_effort") {
    return sendFirstPrompt(workflow, workflow.store.requireTask(task.task_id));
  }
  if (purpose !== "prompt") return;
  workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0 });
  const note = loggedFailureReason(task.task_id, "The prompt");
  await workflow.post({ type: "progress", task_id: task.task_id, text: note });
  workflow.store.patchTodoRow(task.task_id, { note });
  if (task.role !== "author") return endBrokenRun(workflow, task, note);
  if (await settleAndResumeAuthor(workflow, task.task_id)) return;
  await flushFeed(workflow, task, { kind: "error", text: note });
  await workflow.tellAgent(
    noteMessage(
      `Task ${task.task_id}: ${note} The harness is idle. Send the prompt again with prompt_task, or fail the task.`,
    ),
    "blocked",
  );
}

/**
 * Runs one agent turn at a time. Wakes that land during a turn become one follow-up turn.
 * `run` returns at once while a turn is running, so a caller that needs the end awaits `idle`.
 */
export class TurnCoalescer {
  private running: Promise<void> | null = null;
  private rerun = false;

  /** Resolves when no turn runs, and rejects the way a running turn did. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Run a turn only when none is running. For the alarm lane. */
  runIfIdle(turn: () => Promise<void>): Promise<void> {
    return this.running ? Promise.resolve() : this.run(turn);
  }

  async run(turn: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.loop(turn);
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async loop(turn: () => Promise<void>): Promise<void> {
    do {
      this.rerun = false;
      await turn();
    } while (this.rerun);
  }
}
