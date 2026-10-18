import { failTask, MAX_RESTARTS } from "../lifecycle";
import { isTaskFinished } from "../store/state";
import type { WorkflowRuntime } from "../types";
import { drainQueue } from "./harness/prompt-queue";
import type { TaskAlarm } from "./harness/timers";

/**
 * Seconds after its start that a model turn counts as lost. It lies past the bound of the model
 * call, so it finds a live turn only when a page write hangs.
 */
const MODEL_TURN_DEADLINE_SECONDS = 20 * 60;

/** The payload of the deadline alarm of one model turn. */
export type ModelTurnAlarm = { task_id: string; turn_id: string };

/** A model turn in flight, as the code that runs it sees it. */
export type ModelTurn = {
  /** The id the task stores while the turn is in flight. */
  id: string;
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
    id: turnId,
    ended: () => !current(),
    finish: () => {
      if (current()) workflow.store.updateTask(taskId, { model_turn_id: null });
    },
  };
}

/**
 * The model turns the store holds in flight. A new instance runs none of them, since a turn dies
 * with the instance that ran it.
 */
export function lostModelTurns(workflow: WorkflowRuntime): ModelTurnAlarm[] {
  return workflow.store.tasks().flatMap((task) => {
    if (task.model_turn_id === null || isTaskFinished(task.status)) return [];
    return [{ task_id: task.task_id, turn_id: task.model_turn_id }];
  });
}

/** A model turn outlived its deadline. An alarm of an older turn changes nothing. */
export async function onModelTurnDeadline(
  workflow: WorkflowRuntime,
  alarm: ModelTurnAlarm,
): Promise<void> {
  if (!(await restartLostModelTurn(workflow, alarm))) return;
  await drainQueue(workflow, workflow.store.requireTask(alarm.task_id));
}

/**
 * Restart the task of a lost model turn, or fail it once its restarts are used up. An author with
 * its page out goes back in review and keeps its prompt. One without its page produces it again.
 * True when the task restarted. A turn the task no longer holds changes nothing.
 */
export async function restartLostModelTurn(
  workflow: WorkflowRuntime,
  turn: ModelTurnAlarm,
): Promise<boolean> {
  const task = workflow.store.task(turn.task_id);
  if (!task || task.model_turn_id !== turn.turn_id) return false;
  workflow.log(task.task_id, `model turn ${task.model_turn_id} was lost`);
  if (task.restarts >= MAX_RESTARTS) {
    await failTask(workflow, task, "its model turn was lost with no restarts left");
    return false;
  }
  const pageOut = workflow.store.artifact(task.job_id) !== null;
  workflow.store.updateTask(task.task_id, {
    model_turn_id: null,
    restarts: task.restarts + 1,
    status: pageOut ? "in_review" : "working",
  });
  return true;
}

/** Alarm: a restarted model-call author runs its lost model turn again from its queue. */
export async function runLostModelTurnAgain(
  workflow: WorkflowRuntime,
  alarm: TaskAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  if (task) await drainQueue(workflow, task);
}
