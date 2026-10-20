import { isWorkflowFinished } from "../../workflow/store/state";
import type { AgentTurnRow } from "../../workflow/store/workflow-row";
import { noteMessage } from "../transcript/envelope";
import type { WorkflowRuntime } from "../../workflow/types";

/** The alarm payload. The start time tells a stale alarm from the running turn. */
export type TurnAlarm = { started_at: string };

/**
 * What a turn start recorded: its start time, its first transcript row, and its board change. A
 * resumed turn carries the first row and the board change of the lost turn.
 */
export type TurnStart = { startedAt: string; firstRow: number; boardChanged: boolean };

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
 * Record a turn's start, with `takenRow` as its first transcript row unless it resumes a lost
 * turn. Schedule the watchdog alarm, and the heads-up when the turn took a message a person wrote.
 */
export async function armTurnWatchdog(
  workflow: WorkflowRuntime,
  takenRow: number,
): Promise<TurnStart> {
  const startedAt = new Date(workflow.now()).toISOString();
  const lost = workflow.store.agentTurn();
  const seconds = Math.ceil(workflow.config().orchestrator.turn_timeout_minutes * 60);
  const alarm: TurnAlarm = { started_at: startedAt };
  const watchdog = await workflow.scheduleAlarm(seconds, "onTurnTimeout", alarm);
  const headsUp = workflow.transcript.takenMessages().length
    ? await workflow.scheduleAlarm(HEADS_UP_SECONDS, "onTurnHeadsUp", alarm)
    : null;
  const start: TurnStart = {
    startedAt,
    firstRow: lost?.first_row ?? takenRow,
    boardChanged: lost?.board_changed ?? false,
  };
  workflow.store.recordRunningTurn({
    started_at: startedAt,
    first_row: start.firstRow,
    board_changed: start.boardChanged,
    watchdog_schedule: watchdog,
    heads_up_schedule: headsUp,
  });
  return start;
}

/**
 * A turn ends. Delete its record and cancel its alarms. Returns true when this turn still owes the
 * reply, false when the watchdog already told the humans that it timed out and the turn has only
 * to release them.
 */
export async function disarmTurnWatchdog(
  workflow: WorkflowRuntime,
  startedAt: string,
): Promise<boolean> {
  const turn = runningTurnOf(workflow, startedAt);
  if (!turn) return false;
  workflow.store.deleteAgentTurn();
  workflow.transcript.deleteTaken();
  await cancelTurnAlarms(workflow, turn);
  return true;
}

/**
 * Alarm: the turn armed with this start time still runs after `HEADS_UP_SECONDS`. Tell its chat
 * threads and keep their working status. The turn still owes its reply.
 */
export async function onTurnHeadsUp(workflow: WorkflowRuntime, alarm: TurnAlarm): Promise<void> {
  if (!runningTurnOf(workflow, alarm.started_at)) return;
  workflow.store.clearHeadsUpSchedule();
  workflow.log(null, "agent turn still running, heads-up posted");
  await postKeepingWorkingStatus(workflow, HEADS_UP_TEXT);
}

/**
 * Alarm: the turn armed with this start time never ended. Tell the people it answers and the
 * starting session, and let go of it. On a finished workflow where nobody waits, only take the
 * threads out of their working status.
 */
export async function onTurnTimeout(workflow: WorkflowRuntime, alarm: TurnAlarm): Promise<void> {
  const turn = runningTurnOf(workflow, alarm.started_at);
  if (!turn) return;
  workflow.store.deleteAgentTurn();
  const answering = workflow.transcript.answering();
  workflow.transcript.deleteTaken();
  if (turn.heads_up_schedule) await workflow.cancelAlarm(turn.heads_up_schedule);
  if (isWorkflowFinished(workflow.store.requireWorkflowRow().status) && !answering.length)
    return workflow.release();
  const minutes = workflow.config().orchestrator.turn_timeout_minutes;
  workflow.log(null, `agent turn timed out after ${minutes} minutes`);
  await workflow.post({ type: "turn_failed", text: turnTimeoutText(minutes) }, { answering });
}

/** Queued for the agent when a new instance picks up a turn its predecessor lost. */
export const LOST_TURN_TEXT =
  "The orchestrator restarted in the middle of your last turn, most likely for a deploy. Tool calls you made after the restart did not take effect and their results may be missing from this transcript. Read the task state before you act on it, then continue. Answer the person who wrote before the restart when they still wait on a reply.";

/**
 * Mark a turn still recorded as running lost when the Durable Object starts, and wake the agent
 * with an agent note. The resumed turn keeps the lost turn's messages, transcript rows and board
 * change, and a person who waited hears that it starts again. With no lost turn, or with a
 * finished workflow, rows that wait to wake the agent get a `runAgent` alarm. True when a turn
 * was resumed.
 */
export async function resumeLostTurn(workflow: WorkflowRuntime): Promise<boolean> {
  const turn = workflow.store.agentTurn();
  if (turn?.status !== "running") {
    await wakeForWaitingRows(workflow);
    return false;
  }
  workflow.store.markTurnLost();
  await cancelTurnAlarms(workflow, turn);
  if (
    isWorkflowFinished(workflow.store.requireWorkflowRow().status) &&
    !workflow.transcript.takenMessages().length
  ) {
    workflow.store.deleteAgentTurn();
    workflow.transcript.deleteTaken();
    await workflow.release();
    await wakeForWaitingRows(workflow);
    return false;
  }
  workflow.log(
    null,
    `the turn started at ${turn.started_at} was lost with its Durable Object. resuming.`,
  );
  if (workflow.transcript.takenMessages().length) {
    await postKeepingWorkingStatus(workflow, LOST_PLACE_TEXT);
  }
  await workflow.tellAgent(noteMessage(LOST_TURN_TEXT), "blocked");
  return true;
}

/** Arm the `runAgent` alarm when rows wait to wake the agent, since the lost isolate took their turn with it. */
async function wakeForWaitingRows(workflow: WorkflowRuntime): Promise<void> {
  const waking = workflow.transcript.inbox().some((row) => row.wake !== "none");
  if (waking) await workflow.scheduleAlarm(0, "runAgent", {});
}

/** The record of the running turn that started at `startedAt`. Null for a stale start. */
function runningTurnOf(workflow: WorkflowRuntime, startedAt: string): AgentTurnRow | null {
  const turn = workflow.store.agentTurn();
  return turn?.status === "running" && turn.started_at === startedAt ? turn : null;
}

async function cancelTurnAlarms(workflow: WorkflowRuntime, turn: AgentTurnRow): Promise<void> {
  if (turn.watchdog_schedule) await workflow.cancelAlarm(turn.watchdog_schedule);
  if (turn.heads_up_schedule) await workflow.cancelAlarm(turn.heads_up_schedule);
}

/** Post to every chat thread among the reply targets and keep its working status. */
async function postKeepingWorkingStatus(workflow: WorkflowRuntime, text: string): Promise<void> {
  for (const target of workflow.store.replyTargets()) {
    if (target.source !== "chat") continue;
    await workflow.post({ type: "info", text }, { reply_to: target }, { keepSession: true });
  }
}
