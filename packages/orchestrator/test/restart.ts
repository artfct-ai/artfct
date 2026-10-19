import { resumeLostTurn } from "../src/agent/turn/watchdog";
import { armWorkflowEndAlarm, resumeWorkflowEnd } from "../src/workflow/lifecycle";
import { armLostCallsAlarm, resumeLostCalls, type LostCallsAlarm } from "../src/workflow/restart";
import type { TaskAlarm } from "../src/workflow/task/harness/timers";
import { settleIdleAuthors } from "../src/workflow/task/harness/turn";
import { runLostModelTurnAgain } from "../src/workflow/task/model-turn";
import { provisionQueuedTasks } from "../src/workflow/task/sandbox/sandbox";
import type { FakeRuntime } from "./fake-runtime";

/** Run the start step of an instance the Durable Object restarted as. The alarms it arms stay armed. */
export async function startRestartedInstance(restarted: FakeRuntime): Promise<void> {
  await armLostCallsAlarm(restarted);
  await armWorkflowEndAlarm(restarted);
  await resumeLostTurn(restarted);
  await provisionQueuedTasks(restarted);
  await settleIdleAuthors(restarted);
}

/**
 * Run the start step of an instance the Durable Object restarted as. Fire the restart alarm, each
 * lost model turn it runs again, and the alarm that goes on with a workflow end, as the platform
 * does. The settles of lost rulings stay armed.
 */
export async function runStartStep(restarted: FakeRuntime): Promise<void> {
  await startRestartedInstance(restarted);
  for (const alarm of restarted.alarmsFor("resumeLostCalls")) {
    await restarted.cancelAlarm(alarm.id);
    await resumeLostCalls(restarted, alarm.payload as LostCallsAlarm);
  }
  for (const alarm of restarted.alarmsFor("runLostModelTurnAgain")) {
    await restarted.cancelAlarm(alarm.id);
    await runLostModelTurnAgain(restarted, alarm.payload as TaskAlarm);
  }
  for (const alarm of restarted.alarmsFor("resumeWorkflowEnd")) {
    await restarted.cancelAlarm(alarm.id);
    await resumeWorkflowEnd(restarted);
  }
}
