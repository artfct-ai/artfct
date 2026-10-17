import { resumeLostTurn } from "../src/agent/turn/watchdog";
import { settleIdleAuthors } from "../src/workflow/task/harness/turn";
import { provisionQueuedTasks } from "../src/workflow/task/sandbox/sandbox";
import {
  onModelTurnDeadline,
  resumeLostModelTurns,
  type ModelTurnAlarm,
} from "../src/workflow/task/model-turn";
import type { FakeRuntime } from "./fake-runtime";

/**
 * Run the start step of an instance the Durable Object restarted as, and fire the alarms it arms
 * for now, as the platform does.
 */
export async function runStartStep(restarted: FakeRuntime): Promise<void> {
  await resumeLostModelTurns(restarted);
  await resumeLostTurn(restarted);
  await provisionQueuedTasks(restarted);
  await settleIdleAuthors(restarted);
  const due = restarted.alarmsFor("onModelTurnDeadline").filter((alarm) => alarm.delay === 0);
  for (const alarm of due) {
    await restarted.cancelAlarm(alarm.id);
    await onModelTurnDeadline(restarted, alarm.payload as ModelTurnAlarm);
  }
}
