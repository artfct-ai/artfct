import { lostJudgeRulings } from "./refiner/loop";
import type { TaskAlarm } from "./task/harness/timers";
import { lostModelTurns, resumeLostModelTurns, type ModelTurnAlarm } from "./task/model-turn";
import type { WorkflowRuntime } from "./types";

/** The payload of the restart alarm: the calls the old instance had out when it was lost. */
export type LostCallsAlarm = { model_turns: ModelTurnAlarm[]; judge_runs: TaskAlarm[] };

/** Start step: arm one alarm due now for the model turns and ruling calls the old instance lost. */
export async function armLostCallsAlarm(workflow: WorkflowRuntime): Promise<void> {
  const alarm: LostCallsAlarm = {
    model_turns: lostModelTurns(workflow),
    judge_runs: lostJudgeRulings(workflow),
  };
  if (alarm.model_turns.length === 0 && alarm.judge_runs.length === 0) return;
  await workflow.scheduleAlarm(0, "resumeLostCalls", alarm);
}

/**
 * Alarm: restart or fail the task of each lost model turn, then arm the calls the old instance
 * lost, each in its own alarm. A ruling is asked again only after its author failed or restarted,
 * so an author that failed has handed its artifact to a person and its ruling is not asked.
 */
export async function resumeLostCalls(
  workflow: WorkflowRuntime,
  alarm: LostCallsAlarm,
): Promise<void> {
  await resumeLostModelTurns(workflow, alarm.model_turns);
  for (const run of alarm.judge_runs) {
    await workflow.scheduleAlarm(0, "settleLostJudgeRuling", run);
  }
}
