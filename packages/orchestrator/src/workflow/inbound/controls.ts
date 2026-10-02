import type { CancelNotification } from "@agentclientprotocol/sdk";
import { AgentMethods } from "@artfct-ai/acp/methods";
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
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
    await workflow.post({ type: "info", text: "Not authorized." }, event.reply_to);
    return "not authorized";
  }
  const job = jobForEvent(workflow, event);
  const task = job ? workflow.store.authorOrResearcherTaskOf(job.job_id) : null;
  switch (event.control) {
    case "cancel":
      return cancel(workflow, event);
    case "pause":
      if (task) await pauseTask(workflow, task);
      return null;
    case "resume":
      if (task) await resumeTask(workflow, task, event.text);
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
async function cancel(workflow: WorkflowRuntime, event: InboundEvent): Promise<string | null> {
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
  await cancelWorkflow(workflow, actor, reason);
  return null;
}

/** Who cancelled, and what they said when they did. */
function cancelReason(actor: Actor, text: string): string {
  const who = `Cancelled by ${actor.display_name ?? actor.person_id}.`;
  return text.trim() ? `${who} ${text.trim()}` : who;
}

/** Cancel every active task, author and researcher tasks first, and close the workflow. */
async function cancelWorkflow(
  workflow: WorkflowRuntime,
  actor: Actor,
  reason = cancelReason(actor, ""),
): Promise<void> {
  for (const task of workflow.store.activeAuthorAndResearcherTasks()) {
    await cancelTask(workflow, task, reason);
  }
  for (const task of workflow.store.activeRefinerRuns()) await cancelTask(workflow, task, reason);
  await changeWorkflowStatus(workflow, "cancelled");
  await workflow.post({ type: "info", text: `Cancelled. ${TAG_TO_START_AGAIN}` });
  await unbindCodeHost(workflow);
}

/** Stop the current turn and hold queued prompts until resume. */
export async function pauseTask(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  if (isTaskFinished(task.status) || task.paused_at !== null) return;
  workflow.store.updateTask(task.task_id, {
    paused_at: new Date(workflow.now()).toISOString(),
  });
  await flushBoards(workflow, task.job_id);
  const sandbox = workflow.store.sandbox(task.task_id);
  if (sandbox?.session_id && sandbox.prompt_in_flight) {
    const params: CancelNotification = { sessionId: sandbox.session_id };
    sendNotification(workflow, task, AgentMethods.sessionCancel, params);
  }
  await workflow.post({
    type: "info",
    text: `Paused ${task.task_id}. Reply "resume" to continue.`,
  });
}

/** Continue a paused task. Empty text becomes a generic continue prompt. */
export async function resumeTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  text: string,
): Promise<void> {
  if (task.paused_at === null) return;
  workflow.store.updateTask(task.task_id, { paused_at: null });
  if (workflow.store.sandbox(task.task_id)) {
    workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0 });
  }
  await flushBoards(workflow, task.job_id);
  await workflow.post({ type: "info", text: `Resumed ${task.task_id}.` });
  const fresh = workflow.store.requireTask(task.task_id);
  await promptTask(workflow, fresh, text.trim() || "Continue where you left off.");
}
