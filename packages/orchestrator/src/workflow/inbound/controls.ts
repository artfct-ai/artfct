import type { CancelNotification } from "@agentclientprotocol/sdk";
import { AgentMethods } from "@artfct-ai/acp/methods";
import type { Actor, InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import { flushBoards } from "../board/board";
import { closeSessionFeed, STOPPED_CLOSING } from "../feed/feed";
import { cancelTask, endWorkflow, workflowEnding } from "../lifecycle";
import { promptTask } from "../task/harness/prompt-queue";
import { taskAtWork } from "../task/at-work";
import { onBridgeLost, sendNotification } from "../task/harness/bridge";
import { clearTaskTimers, closeContainer } from "../task/sandbox/sandbox";
import type { WorkflowRuntime } from "../types";
import { isTaskFinished } from "../store/state";
import type { TaskRow } from "../store/tasks";
import { jobByIssueBinding, jobForEvent } from "./lookup";

/**
 * Run a verbal command from a person: cancel, pause, resume, instruct. Only team members may use them.
 * Returns the reason the word was left alone, or null when it was executed.
 */
export async function applyVerbalCommand(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<string | null> {
  if (!event.actor) {
    const to = event.reply_to ? { reply_to: event.reply_to } : undefined;
    await workflow.post({ type: "info", text: "Not authorized." }, to);
    return "not authorized";
  }
  const answering = event.reply_to ? [event.reply_to] : [];
  const job = jobForEvent(workflow, event);
  const task = job ? workflow.store.authorOrResearcherTaskOf(job.job_id) : null;
  switch (event.control) {
    case "cancel":
      return cancel(workflow, event, answering);
    case "pause":
      if (task) await pauseTask(workflow, task, answering);
      return null;
    case "resume":
      if (task) await resumeTask(workflow, task, { text: event.text, answering });
      return null;
    case "instruct":
      if (task) await promptTask(workflow, task, event.text);
      return null;
    default:
      return null;
  }
}

/**
 * A cancel on a tracker issue other than the subject issue cancels that issue's job alone, and
 * the notice answers the people who wrote from `answering`. One on an issue whose job is over,
 * or whose artifact the host accepted, is left alone, and so is one while the workflow ends.
 * Everything else cancels the workflow.
 * Returns the reason it was left alone, or null.
 */
async function cancel(
  workflow: WorkflowRuntime,
  event: InboundEvent,
  answering: ReplyTarget[],
): Promise<string | null> {
  const actor = event.actor!;
  const reason = cancelReason(actor, event.text);
  const owner = jobByIssueBinding(workflow, event);
  if (owner && workflow.store.artifact(owner.job_id)?.status === "accepted") {
    const why = `the artifact of job ${owner.job_id} is accepted`;
    workflow.log(null, `cancel ignored: ${why} (${reason})`);
    return why;
  }
  const subject = workflow.store.subject();
  const subjectIssue = subject?.kind === "issue" ? subject.issue_id : null;
  if (owner && owner.issue_id !== subjectIssue) {
    const task = workflow.store.authorOrResearcherTaskOf(owner.job_id);
    if (isTaskFinished(task.status)) {
      const why = `job ${owner.job_id} is already over`;
      workflow.log(null, `cancel ignored: ${why} (${reason})`);
      return why;
    }
    await cancelTask(workflow, task, reason);
    await workflow.post({ type: "info", text: `Cancelled job ${owner.job_id}.` }, { answering });
    return null;
  }
  if (workflowEnding(workflow)) {
    const why = "the workflow is already ending";
    workflow.log(null, `cancel ignored: ${why} (${reason})`);
    return why;
  }
  await endWorkflow(workflow, { ends_as: "cancelled", reason, answering, posted: false });
  return null;
}

/** Who cancelled, and what they said when they did. */
function cancelReason(actor: Actor, text: string): string {
  const who = `Cancelled by ${actor.display_name ?? actor.email ?? "a person"}.`;
  return text.trim() ? `${who} ${text.trim()}` : who;
}

/**
 * Stop the current turn and hold queued prompts until resume. The notice answers the people who
 * wrote from `answering`.
 */
export async function pauseTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  answering: ReplyTarget[],
): Promise<void> {
  if (isTaskFinished(task.status) || task.paused_at !== null) return;
  workflow.store.updateTask(task.task_id, {
    paused_at: new Date(workflow.now()).toISOString(),
  });
  await flushBoards(workflow, task.job_id);
  cancelPromptTurn(workflow, task);
  await workflow.post(
    { type: "info", text: `Paused ${task.task_id}. Reply "resume" to continue.` },
    { answering },
  );
}

/**
 * What a stop found the author doing. `writing` is a model turn whose page write is out. `closed`
 * is an idle harness author whose container the stop closed.
 */
export type StopOutcome = "cancelled" | "ended" | "writing" | "closed" | "idle";

/**
 * End the author's current turn and drop its queued prompts, so it waits for the person. A
 * running turn gets a cancel. An unfinished harness author's container goes, also when it is
 * idle, since a cancel on a dropped socket is lost. A model turn whose page write is out ends
 * once the write returns, so the author does not start a second write beside it.
 */
export async function stopAuthor(workflow: WorkflowRuntime, author: TaskRow): Promise<StopOutcome> {
  workflow.store.clearPromptQueue(author.task_id);
  const harnessAuthor = workflow.store.sandbox(author.task_id) !== null;
  if (harnessAuthor) workflow.store.updateSandbox(author.task_id, { stopped_early: 0 });
  const connected = workflow.connections(author.task_id).length > 0;
  const cancelled = connected && cancelPromptTurn(workflow, author);
  const unfinished = !isTaskFinished(author.status);
  const atWork = taskAtWork(workflow, author);
  const turnId = workflow.store.requireTask(author.task_id).model_turn_id;
  const writing = atWork && turnId !== null && workflow.pageWritesOut.has(turnId);
  const endsTurn = harnessAuthor ? unfinished : atWork && !writing;
  if (endsTurn) await endStoppedTurn(workflow, author);
  await closeSessionFeed(workflow, author, STOPPED_CLOSING);
  if (cancelled) return "cancelled";
  if (writing) return "writing";
  if (atWork) return "ended";
  return endsTurn ? "closed" : "idle";
}

/**
 * End the turn of a stopped author, whether it runs, starts, resumes, or idles. A harness author
 * ends its generation, so a call it awaited before the stop does not act after it, and a starting
 * one becomes working. A model-call author goes back in review when its page is out, since it
 * takes a prompt only there. It lets go of its model turn, also a lost one that waits for its
 * run-again alarm, so that alarm does nothing.
 */
async function endStoppedTurn(workflow: WorkflowRuntime, author: TaskRow): Promise<void> {
  const sandbox = workflow.store.sandbox(author.task_id);
  if (sandbox) {
    const starting = author.status === "queued" || author.status === "provisioning";
    await clearTaskTimers(workflow, sandbox);
    workflow.store.clearRpc(author.task_id);
    workflow.store.updateSandbox(author.task_id, {
      prompt_in_flight: 0,
      turn_text: "",
      generation: sandbox.generation + 1,
    });
    if (starting) workflow.store.updateTask(author.task_id, { status: "working" });
    await closeContainer(workflow, author, "a person pressed Stop");
  } else {
    const pageOut = workflow.store.artifact(author.job_id) !== null;
    workflow.store.updateTask(author.task_id, {
      status: pageOut ? "in_review" : "working",
      model_turn_id: null,
    });
  }
  await flushBoards(workflow, author.job_id);
}

/** Send the harness session a cancel when a prompt turn runs. True when one was sent. */
function cancelPromptTurn(workflow: WorkflowRuntime, task: TaskRow): boolean {
  const sandbox = workflow.store.sandbox(task.task_id);
  if (!sandbox?.session_id || !sandbox.prompt_in_flight) return false;
  const params: CancelNotification = { sessionId: sandbox.session_id };
  sendNotification(workflow, task, AgentMethods.sessionCancel, params);
  return true;
}

/**
 * Continue a paused task. Empty text becomes a generic continue prompt, which waits for the answer
 * to a turn the pause cancelled. A turn whose bridge was lost during the pause is recovered. The
 * notice answers the people who wrote from `answering`.
 */
export async function resumeTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  resume: { text: string; answering: ReplyTarget[] },
): Promise<void> {
  const { text, answering } = resume;
  if (task.paused_at === null) return;
  workflow.store.updateTask(task.task_id, { paused_at: null });
  await flushBoards(workflow, task.job_id);
  await workflow.post({ type: "info", text: `Resumed ${task.task_id}.` }, { answering });
  const fresh = workflow.store.requireTask(task.task_id);
  const pausedGeneration = workflow.store.sandbox(task.task_id)?.generation;
  await promptTask(workflow, fresh, text.trim() || "Continue where you left off.");
  if (pausedGeneration !== undefined) {
    await onBridgeLost(workflow, { task_id: task.task_id, generation: pausedGeneration });
  }
}
