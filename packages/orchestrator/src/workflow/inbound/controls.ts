import type { CancelNotification } from "@agentclientprotocol/sdk";
import { AgentMethods } from "@artfct-ai/acp/methods";
import type { Actor, InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import { TAG_TO_START_AGAIN } from "../../notify/messages";
import { flushBoards } from "../board/board";
import { cancelTask, changeWorkflowStatus, unbindCodeHost } from "../lifecycle";
import { promptTask } from "../task/harness/prompt-queue";
import { sendNotification } from "../task/harness/bridge";
import type { WorkflowRuntime } from "../types";
import { isTaskFinished } from "../store/state";
import type { TaskRow } from "../store/tasks";
import { jobByIssueBinding, jobForEvent } from "./lookup";

/**
 * Run a human control word: cancel, pause, resume, instruct. Only team members may use them.
 * Returns the reason the word was left alone, or null when it was executed.
 */
export async function applyControlWord(
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
 * A cancel on a tracker issue the workflow did not start from cancels that issue's job alone.
 * One on an issue whose artifact the host accepted is left alone. Everything else cancels the
 * workflow. Returns the reason it was left alone, or null.
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
  const origin = workflow.state.origin;
  const originIssue = origin?.source === "tracker" ? origin.issue_id : null;
  if (owner && owner.issue_id !== originIssue) {
    await cancelTask(workflow, workflow.store.authorOrResearcherTaskOf(owner.job_id), reason);
    return null;
  }
  await cancelWorkflow(workflow, reason, answering);
  return null;
}

/** Who cancelled, and what they said when they did. */
function cancelReason(actor: Actor, text: string): string {
  const who = `Cancelled by ${actor.display_name ?? actor.person_id}.`;
  return text.trim() ? `${who} ${text.trim()}` : who;
}

/**
 * Cancel every active task, author and researcher tasks first, and close the workflow. The
 * notice answers the people who wrote from `answering`.
 */
async function cancelWorkflow(
  workflow: WorkflowRuntime,
  reason: string,
  answering: ReplyTarget[],
): Promise<void> {
  for (const task of workflow.store.activeAuthorAndResearcherTasks()) {
    await cancelTask(workflow, task, reason);
  }
  for (const task of workflow.store.activeRefinerRuns()) await cancelTask(workflow, task, reason);
  await changeWorkflowStatus(workflow, "cancelled");
  await workflow.post({ type: "info", text: `Cancelled. ${TAG_TO_START_AGAIN}` }, { answering });
  await unbindCodeHost(workflow);
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

/** Send the harness session a cancel when a prompt turn runs. True when one was sent. */
export function cancelPromptTurn(workflow: WorkflowRuntime, task: TaskRow): boolean {
  const sandbox = workflow.store.sandbox(task.task_id);
  if (!sandbox?.session_id || !sandbox.prompt_in_flight) return false;
  const params: CancelNotification = { sessionId: sandbox.session_id };
  sendNotification(workflow, task, AgentMethods.sessionCancel, params);
  return true;
}

/**
 * Continue a paused task. Empty text becomes a generic continue prompt. The notice answers the
 * people who wrote from `answering`.
 */
export async function resumeTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  resume: { text: string; answering: ReplyTarget[] },
): Promise<void> {
  const { text, answering } = resume;
  if (task.paused_at === null) return;
  workflow.store.updateTask(task.task_id, { paused_at: null });
  if (workflow.store.sandbox(task.task_id)) {
    workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0 });
  }
  await flushBoards(workflow, task.job_id);
  await workflow.post({ type: "info", text: `Resumed ${task.task_id}.` }, { answering });
  const fresh = workflow.store.requireTask(task.task_id);
  await promptTask(workflow, fresh, text.trim() || "Continue where you left off.");
}
