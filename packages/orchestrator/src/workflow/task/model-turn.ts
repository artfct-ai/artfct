import { failTask, MAX_RESTARTS } from "../lifecycle";
import { isTaskFinished } from "../store/state";
import type { WorkflowRuntime } from "../types";
import { drainQueue } from "./harness/prompt-queue";

/**
 * Seconds after its start that a model turn counts as lost. It lies past the bound of the model
 * call, so it finds a live turn only when a page write hangs.
 */
const MODEL_TURN_DEADLINE_SECONDS = 20 * 60;

/** The payload of an alarm about one model turn: its deadline, or the run-again alarm of a lost one. */
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
 * with the instance that ran it. A lost turn that waits for its run-again alarm counts again.
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
  if (!(await restartLostModelTurn(workflow, alarm, null))) return;
  await drainQueue(workflow, workflow.store.requireTask(alarm.task_id));
}

/**
 * Restart the task of a lost model turn, or fail it once its restarts are used up. An author with
 * its page out goes back in review and keeps its prompt. One without its page produces it again.
 * The task then holds `nextTurnId`. True when the task restarted. A turn it no longer holds
 * changes nothing.
 */
async function restartLostModelTurn(
  workflow: WorkflowRuntime,
  turn: ModelTurnAlarm,
  nextTurnId: string | null,
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
    model_turn_id: nextTurnId,
    restarts: task.restarts + 1,
    status: pageOut ? "in_review" : "working",
  });
  return true;
}

/**
 * Restart or fail the task of each lost model turn, without starting a model call. Each restarted
 * author holds a new turn id until its own alarm, due now, runs the turn again. A delivery of an
 * alarm that names the old id again changes nothing.
 */
export async function resumeLostModelTurns(
  workflow: WorkflowRuntime,
  turns: ModelTurnAlarm[],
): Promise<void> {
  for (const turn of turns) {
    const rerun: ModelTurnAlarm = { task_id: turn.task_id, turn_id: crypto.randomUUID() };
    if (!(await restartLostModelTurn(workflow, turn, rerun.turn_id))) continue;
    await workflow.scheduleAlarm(0, "runLostModelTurnAgain", rerun);
  }
}

/**
 * Alarm: a restarted model-call author runs its lost model turn again from its queue. It acts
 * only while the author still holds the turn, so a stop or a later restart in between wins.
 */
export async function runLostModelTurnAgain(
  workflow: WorkflowRuntime,
  alarm: ModelTurnAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  if (task?.model_turn_id !== alarm.turn_id) return;
  workflow.store.updateTask(task.task_id, { model_turn_id: null });
  await drainQueue(workflow, workflow.store.requireTask(task.task_id));
}
