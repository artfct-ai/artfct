import { isTaskFinished } from "./store/state";
import type { TaskRow } from "./store/tasks";
import type { WorkflowRuntime } from "./types";

/** True while the author has a turn running or a prompt waiting for one. */
export function authorBusy(workflow: WorkflowRuntime, author: TaskRow): boolean {
  if (isTaskFinished(author.status)) return false;
  return author.status !== "in_review" || workflow.store.peekPrompt(author.task_id) !== null;
}

/**
 * A prompt is about to reach an idle author whose artifact the humans hold, so a follow-up
 * starts and the boards of its job move to the end of their threads. True when one started.
 */
export function startFollowUp(workflow: WorkflowRuntime, task: TaskRow): boolean {
  if (task.role !== "author" || authorBusy(workflow, task)) return false;
  if (workflow.store.artifact(task.job_id)?.status !== "ready") return false;
  workflow.store.relocateBoards(task.job_id);
  workflow.log(task.task_id, `follow-up started on the artifact of job ${task.job_id}`);
  return true;
}
