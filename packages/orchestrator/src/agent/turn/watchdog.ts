import { isWorkflowFinished } from "../../workflow/store/state";
import { noteMessage } from "../transcript/envelope";
import type { WorkflowRuntime } from "../../workflow/types";

/** The alarm payload. The stamp tells a late alarm from the turn it was armed for. */
export type TurnAlarm = { started_at: string };

/** Posted by the watchdog when a turn passes its deadline without a reply. */
export function turnTimeoutText(minutes: number): string {
  return `I have been working on this for over ${minutes} minutes without a reply. Send your message again to retry.`;
}

/**
 * A turn starts. Record when, and schedule the alarm that reports a turn that never ends.
 * Returns the stamp that identifies this turn.
 */
export async function armTurnWatchdog(workflow: WorkflowRuntime): Promise<string> {
  const startedAt = new Date(workflow.now()).toISOString();
  if (workflow.state.turn_watchdog) await workflow.cancelAlarm(workflow.state.turn_watchdog);
  const seconds = Math.ceil(workflow.config().orchestrator.turn_timeout_minutes * 60);
  const alarm: TurnAlarm = { started_at: startedAt };
  const scheduleId = await workflow.scheduleAlarm(seconds, "onTurnTimeout", alarm);
  workflow.patchState({ turn_started_at: startedAt, turn_watchdog: scheduleId });
  return startedAt;
}

/**
 * A turn ends. Cancel the alarm. Returns true when this turn still owned the reply, false
 * when the watchdog already told the humans that it timed out.
 */
export async function disarmTurnWatchdog(
  workflow: WorkflowRuntime,
  startedAt: string,
): Promise<boolean> {
  if (workflow.state.turn_started_at !== startedAt) return false;
  const scheduleId = workflow.state.turn_watchdog;
  workflow.patchState({ turn_started_at: null, turn_watchdog: null });
  if (scheduleId) await workflow.cancelAlarm(scheduleId);
  return true;
}

/** Alarm: the turn armed with this stamp never ended. Tell the humans and let go of it. */
export async function onTurnTimeout(workflow: WorkflowRuntime, alarm: TurnAlarm): Promise<void> {
  if (workflow.state.turn_started_at !== alarm.started_at) return;
  workflow.patchState({ turn_started_at: null, turn_watchdog: null });
  if (isWorkflowFinished(workflow.state.status)) return;
  const minutes = workflow.config().orchestrator.turn_timeout_minutes;
  workflow.log(null, `agent turn timed out after ${minutes} minutes`);
  await workflow.post({ type: "info", text: turnTimeoutText(minutes) });
}

/** Queued for the agent when a new instance picks up a turn its predecessor lost. */
export const LOST_TURN_TEXT =
  "The orchestrator restarted in the middle of your last turn, most likely for a deploy. Tool calls you made after the restart did not take effect and their results may be missing from this transcript. Read the task state before you act on it, then continue.";

/**
 * Forget a turn still marked as running when the Durable Object starts, and wake the agent
 * with a note. True when a turn was resumed.
 */
export async function resumeLostTurn(workflow: WorkflowRuntime): Promise<boolean> {
  const startedAt = workflow.state.turn_started_at;
  if (!startedAt) return false;
  const scheduleId = workflow.state.turn_watchdog;
  workflow.patchState({ turn_started_at: null, turn_watchdog: null });
  if (scheduleId) await workflow.cancelAlarm(scheduleId);
  if (isWorkflowFinished(workflow.state.status)) return false;
  workflow.log(
    null,
    `the turn started at ${startedAt} was lost with its Durable Object. resuming.`,
  );
  await workflow.tellAgent(noteMessage(LOST_TURN_TEXT), "blocked");
  return true;
}
