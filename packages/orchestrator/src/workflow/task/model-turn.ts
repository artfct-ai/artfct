import { failTask, MAX_RESTARTS } from "../lifecycle";
import { isTaskFinished } from "../store/state";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";
import { drainQueue } from "./harness/prompt-queue";

/**
 * Seconds after its start that a model turn counts as lost. It lies past the bound of the model
 * call, so it finds a live turn only when a page write hangs.
 */
const MODEL_TURN_DEADLINE_SECONDS = 20 * 60;

/** The payload of the deadline alarm of one model turn. */
export type ModelTurnAlarm = { task_id: string; turn_id: string };

/** A model turn in flight, as the code that runs it sees it. */
export type ModelTurn = {
  /** True once the task no longer holds this turn in flight, so its answer changes nothing. */
  ended: () => boolean;
  /** End the turn in the same synchronous step that records its answer. */
  finish: () => void;
};

/**
 * Start a model turn of a model-call task: the task is working and stores the id of the turn.
 * The deadline alarm wakes the workflow when the turn is lost.
 */
export async function startModelTurn(
  workflow: WorkflowRuntime,
  taskId: string,
): Promise<ModelTurn> {
  const turnId = crypto.randomUUID();
  workflow.store.updateTask(taskId, { status: "working", model_turn_id: turnId });
  const alarm: ModelTurnAlarm = { task_id: taskId, turn_id: turnId };
  await workflow.scheduleAlarm(MODEL_TURN_DEADLINE_SECONDS, "onModelTurnDeadline", alarm);
  const current = () => workflow.store.task(taskId)?.model_turn_id === turnId;
  return {
    ended: () => !current(),
    finish: () => {
      if (current()) workflow.store.updateTask(taskId, { model_turn_id: null });
    },
  };
}

/**
 * Arm the deadline of every model turn the store holds in flight to fire now. A new instance runs
 * none of them, since a turn dies with the instance that ran it.
 */
export async function resumeLostModelTurns(workflow: WorkflowRuntime): Promise<void> {
  for (const task of workflow.store.tasks()) {
    if (task.model_turn_id === null || isTaskFinished(task.status)) continue;
    const alarm: ModelTurnAlarm = { task_id: task.task_id, turn_id: task.model_turn_id };
    await workflow.scheduleAlarm(0, "onModelTurnDeadline", alarm);
  }
}

/** A model turn outlived its deadline or a restart. An alarm of an older turn changes nothing. */
export async function onModelTurnDeadline(
  workflow: WorkflowRuntime,
  alarm: ModelTurnAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  if (!task || task.model_turn_id !== alarm.turn_id) return;
  await resumeLostModelTurn(workflow, task);
}

/**
 * Run a lost model turn again, as a restart of its task. An author with its page out goes back
 * in review and takes the prompt it kept. One without its page queues to produce it.
 */
async function resumeLostModelTurn(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  workflow.log(task.task_id, `model turn ${task.model_turn_id} was lost`);
  if (task.restarts >= MAX_RESTARTS) {
    return failTask(workflow, task, "its model turn was lost with no restarts left");
  }
  const pageOut = workflow.store.artifact(task.job_id) !== null;
  workflow.store.updateTask(task.task_id, {
    model_turn_id: null,
    restarts: task.restarts + 1,
    status: pageOut ? "in_review" : "working",
  });
  await drainQueue(workflow, workflow.store.requireTask(task.task_id));
}
