import { isWorkflowFinished } from "../../workflow/store/state";
import { noteMessage } from "../transcript/envelope";
import type { WorkflowRuntime } from "../../workflow/types";

/** The alarm payload. The stamp tells a late alarm from the turn it was armed for. */
export type TurnAlarm = { started_at: string };

/** Seconds into a turn on a person's message before its chat threads hear that it still runs. */
export const HEADS_UP_SECONDS = 60;

/** The heads-up posted once a turn on a person's message runs for `HEADS_UP_SECONDS`. */
export const HEADS_UP_TEXT = "Still working on this.";

/** Posted when a new Durable Object instance resumes a lost turn that a person waited on. */
export const LOST_PLACE_TEXT = "I lost my place and am picking this up again.";

/** Posted by the watchdog when a turn passes its deadline without a reply. */
export function turnTimeoutText(minutes: number): string {
  return `I have been working on this for over ${minutes} minutes without a reply. Send your message again to retry.`;
}

/**
 * Record a turn's start and the messages people wrote for it. Schedule the watchdog alarm, and
 * the heads-up when someone wrote. Returns the stamp that identifies the turn.
 */
export async function armTurnWatchdog(
  workflow: WorkflowRuntime,
  messages: string[],
): Promise<string> {
  const startedAt = new Date(workflow.now()).toISOString();
  await cancelTurnAlarms(workflow);
  const seconds = Math.ceil(workflow.config().orchestrator.turn_timeout_minutes * 60);
  const alarm: TurnAlarm = { started_at: startedAt };
  const watchdog = await workflow.scheduleAlarm(seconds, "onTurnTimeout", alarm);
  const headsUp = messages.length
    ? await workflow.scheduleAlarm(HEADS_UP_SECONDS, "onTurnHeadsUp", alarm)
    : null;
  workflow.patchState({
    turn_started_at: startedAt,
    turn_watchdog: watchdog,
    turn_heads_up: headsUp,
    turn_messages: messages,
  });
  return startedAt;
}

/**
 * A turn ends. Cancel its alarms. Returns true when this turn still owned the reply, false
 * when the watchdog already told the humans that it timed out.
 */
export async function disarmTurnWatchdog(
  workflow: WorkflowRuntime,
  startedAt: string,
): Promise<boolean> {
  if (workflow.state.turn_started_at !== startedAt) return false;
  await cancelTurnAlarms(workflow);
  workflow.patchState({ turn_started_at: null, turn_messages: [], turn_first_row: null });
  return true;
}

/**
 * Alarm: the turn armed with this stamp still runs after `HEADS_UP_SECONDS`. Tell its chat
 * threads and keep their working status. The turn still owes its reply.
 */
export async function onTurnHeadsUp(workflow: WorkflowRuntime, alarm: TurnAlarm): Promise<void> {
  if (workflow.state.turn_started_at !== alarm.started_at) return;
  workflow.patchState({ turn_heads_up: null });
  workflow.log(null, "agent turn still running, heads-up posted");
  await postKeepingWorkingStatus(workflow, HEADS_UP_TEXT);
}

/**
 * Alarm: the turn armed with this stamp never ended. Tell the humans and let go of it. On a
 * finished workflow, only take the threads out of their working status.
 */
export async function onTurnTimeout(workflow: WorkflowRuntime, alarm: TurnAlarm): Promise<void> {
  if (workflow.state.turn_started_at !== alarm.started_at) return;
  const headsUp = workflow.state.turn_heads_up;
  workflow.patchState({
    turn_started_at: null,
    turn_watchdog: null,
    turn_heads_up: null,
    turn_messages: [],
    turn_first_row: null,
  });
  if (headsUp) await workflow.cancelAlarm(headsUp);
  if (isWorkflowFinished(workflow.state.status)) return workflow.release();
  const minutes = workflow.config().orchestrator.turn_timeout_minutes;
  workflow.log(null, `agent turn timed out after ${minutes} minutes`);
  await workflow.post({ type: "info", text: turnTimeoutText(minutes) });
}

/** Queued for the agent when a new instance picks up a turn its predecessor lost. */
export const LOST_TURN_TEXT =
  "The orchestrator restarted in the middle of your last turn, most likely for a deploy. Tool calls you made after the restart did not take effect and their results may be missing from this transcript. Read the task state before you act on it, then continue. Answer the person who wrote before the restart when they still wait on a reply.";

/**
 * Forget a turn still marked as running when the Durable Object starts, and wake the agent with
 * an agent note. The resumed turn keeps the lost turn's messages and transcript rows, and a person
 * who waited hears that it starts again. True when a turn was resumed.
 */
export async function resumeLostTurn(workflow: WorkflowRuntime): Promise<boolean> {
  const startedAt = workflow.state.turn_started_at;
  if (!startedAt) return false;
  await cancelTurnAlarms(workflow);
  workflow.patchState({ turn_started_at: null });
  if (isWorkflowFinished(workflow.state.status)) {
    workflow.patchState({ turn_messages: [], turn_first_row: null });
    await workflow.release();
    return false;
  }
  workflow.log(
    null,
    `the turn started at ${startedAt} was lost with its Durable Object. resuming.`,
  );
  if (workflow.state.turn_messages?.length) {
    await postKeepingWorkingStatus(workflow, LOST_PLACE_TEXT);
  }
  await workflow.tellAgent(noteMessage(LOST_TURN_TEXT), "blocked");
  return true;
}

async function cancelTurnAlarms(workflow: WorkflowRuntime): Promise<void> {
  const { turn_watchdog: watchdog, turn_heads_up: headsUp } = workflow.state;
  workflow.patchState({ turn_watchdog: null, turn_heads_up: null });
  if (watchdog) await workflow.cancelAlarm(watchdog);
  if (headsUp) await workflow.cancelAlarm(headsUp);
}

/** Post to every chat thread among the reply targets and keep its working status. */
async function postKeepingWorkingStatus(workflow: WorkflowRuntime, text: string): Promise<void> {
  for (const target of workflow.state.reply_targets) {
    if (target.source !== "chat") continue;
    await workflow.post({ type: "info", text }, target, { keepSession: true });
  }
}
