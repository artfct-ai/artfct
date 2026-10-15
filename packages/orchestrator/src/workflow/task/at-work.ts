import type { TaskStatus } from "@artfct-ai/contracts/types";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

const STARTING_STATUSES: TaskStatus[] = ["queued", "provisioning"];

/**
 * True while the task's turn runs or is about to start. A task starts until it is working. Then
 * a harness task is at work while a prompt is in flight or its handshake is pending, and a
 * model-call task while the store holds its model turn in flight.
 */
export function taskAtWork(workflow: WorkflowRuntime, task: TaskRow): boolean {
  if (STARTING_STATUSES.includes(task.status)) return true;
  const sandbox = workflow.store.sandbox(task.task_id);
  if (sandbox) {
    return sandbox.prompt_in_flight === 1 || workflow.store.handshakePending(task.task_id);
  }
  return workflow.store.requireTask(task.task_id).model_turn_id !== null;
}
