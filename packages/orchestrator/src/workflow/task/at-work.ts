import type { TaskStatus } from "@artfct-ai/contracts/types";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

const STARTING_STATUSES: TaskStatus[] = ["queued", "provisioning"];

/** The turn each model-call task awaits now, per runtime. A turn dies with the isolate, as its model call does. */
const modelTurns = new WeakMap<WorkflowRuntime, Map<string, symbol>>();

/**
 * Run one turn of a model-call task and hold it in flight until it returns. `turnEnded` turns
 * true once a stop ended the turn, so its answer changes nothing.
 */
export async function runModelTurn<T>(
  workflow: WorkflowRuntime,
  taskId: string,
  turn: (turnEnded: () => boolean) => Promise<T>,
): Promise<T> {
  const turns = modelTurns.get(workflow) ?? new Map<string, symbol>();
  modelTurns.set(workflow, turns);
  const token = Symbol(taskId);
  turns.set(taskId, token);
  try {
    return await turn(() => turns.get(taskId) !== token);
  } finally {
    if (turns.get(taskId) === token) turns.delete(taskId);
  }
}

/** End the model-call turn of a task, so the answer of its model call changes nothing. */
export function endModelTurn(workflow: WorkflowRuntime, taskId: string): void {
  modelTurns.get(workflow)?.delete(taskId);
}

/**
 * True while the task's turn runs or is about to start. A task starts until it is working. Then
 * a harness task is at work while a prompt is in flight or its handshake is pending, and a
 * model-call task while its turn is in flight.
 */
export function taskAtWork(workflow: WorkflowRuntime, task: TaskRow): boolean {
  if (STARTING_STATUSES.includes(task.status)) return true;
  const sandbox = workflow.store.sandbox(task.task_id);
  if (sandbox) {
    return sandbox.prompt_in_flight === 1 || workflow.store.handshakePending(task.task_id);
  }
  return modelTurns.get(workflow)?.has(task.task_id) ?? false;
}
