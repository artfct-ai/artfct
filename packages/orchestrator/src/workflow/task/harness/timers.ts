import type { CancelNotification } from "@agentclientprotocol/sdk";
import { AgentMethods } from "@artfct-ai/acp/methods";
import { failTask, restartOrFailTask } from "../../lifecycle";
import { armHelloTimeout, sandboxStartInFlight } from "../sandbox/sandbox";
import { sandboxRefOf } from "../sandbox/size";
import { recoverLostTurn, sendNotification } from "./bridge";
import type { WorkflowRuntime } from "../../types";
import { isTaskFinished } from "../../store/state";
import type { SandboxRow } from "../../store/tasks";

/** Session updates arrive in bursts. One no-progress reschedule per window is enough. */
export const PROGRESS_WINDOW_MS = 30_000;
/** Sent to a silent harness once before the task fails. */
export const NUDGE_TEXT =
  "You have made no visible progress for a while. Summarize where you are and continue, or explain what blocks you.";

/** An alarm that is about a task, whatever its sandbox generation. */
export type TaskAlarm = { task_id: string };

/** An alarm that is about one sandbox generation, and is dropped when a newer one starts. */
export type GenerationAlarm = { task_id: string; generation: number };

/** A harness session update arrived. Restart the no-progress timer at most once per window. */
export async function touchProgress(workflow: WorkflowRuntime, sandbox: SandboxRow): Promise<void> {
  const at = workflow.now();
  const recent =
    sandbox.no_progress_schedule !== null &&
    at - Date.parse(sandbox.last_progress_at) < PROGRESS_WINDOW_MS;
  if (!recent) await armNoProgress(workflow, sandbox, at);
  if (sandbox.nudged) workflow.store.updateSandbox(sandbox.task_id, { nudged: 0 });
}

/** A prompt went out. The harness must show progress within the limit. Keeps the nudge count. */
export async function armNoProgress(
  workflow: WorkflowRuntime,
  sandbox: SandboxRow,
  at?: number,
): Promise<void> {
  const stamp = at ?? workflow.now();
  if (sandbox.no_progress_schedule) await workflow.cancelAlarm(sandbox.no_progress_schedule);
  const scheduleId = await workflow.scheduleAlarm(noProgressSeconds(workflow), "onNoProgress", {
    task_id: sandbox.task_id,
    generation: sandbox.generation,
  });
  workflow.store.updateSandbox(sandbox.task_id, {
    last_progress_at: new Date(stamp).toISOString(),
    no_progress_schedule: scheduleId,
  });
}

/**
 * Alarm: nudge once, then fail if the harness stays silent. A harness with no bridge is gone,
 * not silent, so its turn is recovered instead.
 */
export async function onNoProgress(
  workflow: WorkflowRuntime,
  alarm: GenerationAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const sandbox = workflow.store.sandbox(alarm.task_id);
  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;
  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at !== null) return;
  if (workflow.connections(task.task_id).length === 0) return recoverLostTurn(workflow, task);
  if (sandbox.nudged) return restartOrFailTask(workflow, task, "No progress after a nudge.");
  workflow.log(task.task_id, "no progress. nudging.");
  workflow.store.enqueuePrompt(task.task_id, NUDGE_TEXT);
  if (sandbox.session_id) {
    const params: CancelNotification = { sessionId: sandbox.session_id };
    sendNotification(workflow, task, AgentMethods.sessionCancel, params);
  }
  const scheduleId = await workflow.scheduleAlarm(
    noProgressSeconds(workflow),
    "onNoProgress",
    alarm,
  );
  workflow.store.updateSandbox(task.task_id, { nudged: 1, no_progress_schedule: scheduleId });
}

/** A prompt went out. Its turn must end within `time_elapsed_minutes`. */
export async function armWallClock(workflow: WorkflowRuntime, sandbox: SandboxRow): Promise<void> {
  if (sandbox.wall_schedule) await workflow.cancelAlarm(sandbox.wall_schedule);
  const scheduleId = await workflow.scheduleAlarm(
    timeElapsedMinutes(workflow) * 60,
    "onWallClock",
    {
      task_id: sandbox.task_id,
    },
  );
  workflow.store.updateSandbox(sandbox.task_id, { wall_schedule: scheduleId });
}

/** Alarm: a turn ran past `time_elapsed_minutes`. Fail its task. A turn that ended is left alone. */
export async function onWallClock(workflow: WorkflowRuntime, alarm: TaskAlarm): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const sandbox = workflow.store.sandbox(alarm.task_id);
  if (!task || !sandbox) return;
  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at !== null) return;
  await failTask(
    workflow,
    task,
    `A turn ran longer than the limit of ${timeElapsedMinutes(workflow)} minutes.`,
  );
}

/** Alarm: the bridge never said hello. Restart the sandbox once, then fail. */
export async function onHelloTimeout(
  workflow: WorkflowRuntime,
  alarm: GenerationAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const sandbox = workflow.store.sandbox(alarm.task_id);
  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;
  if (task.status !== "provisioning") return;
  if (sandboxStartInFlight(workflow, task.task_id)) {
    return armHelloTimeout(workflow, { ...sandbox, hello_schedule: null });
  }
  await restartOrFailTask(workflow, task, "The sandbox bridge never connected.");
}

/** Alarm: touch the sandbox while a prompt is in flight, so it does not sleep. Stops when idle. */
export async function keepSandboxAlive(
  workflow: WorkflowRuntime,
  alarm: GenerationAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const sandbox = workflow.store.sandbox(alarm.task_id);
  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;
  if (!sandbox.prompt_in_flight || isTaskFinished(task.status)) {
    workflow.store.updateSandbox(task.task_id, { keepalive_schedule: null });
    return;
  }
  try {
    await workflow.sandbox().keepAlive(sandboxRefOf(task));
  } catch (error) {
    workflow.log(task.task_id, `keepalive failed: ${String(error).slice(0, 200)}`);
  }
  const scheduleId = await workflow.scheduleAlarm(
    keepAliveSeconds(workflow),
    "keepSandboxAlive",
    alarm,
  );
  workflow.store.updateSandbox(task.task_id, { keepalive_schedule: scheduleId });
}

/** A prompt went in flight. Touch the sandbox now, then keep the alarm chain running. */
export async function armKeepAlive(workflow: WorkflowRuntime, sandbox: SandboxRow): Promise<void> {
  const seconds = keepAliveSeconds(workflow);
  if (seconds === 0) return;
  try {
    await workflow.sandbox().keepAlive(sandboxRefOf(workflow.store.requireTask(sandbox.task_id)));
  } catch (error) {
    workflow.log(sandbox.task_id, `keepalive failed: ${String(error).slice(0, 200)}`);
  }
  if (sandbox.keepalive_schedule) return;
  const scheduleId = await workflow.scheduleAlarm(seconds, "keepSandboxAlive", {
    task_id: sandbox.task_id,
    generation: sandbox.generation,
  });
  workflow.store.updateSandbox(sandbox.task_id, { keepalive_schedule: scheduleId });
}

/** A third of `sleep_after`. Zero when the container never sleeps. */
export function keepAliveSeconds(workflow: WorkflowRuntime): number {
  return Math.ceil(workflow.config().orchestrator.sandbox.sleep_after / 3000);
}

function timeElapsedMinutes(workflow: WorkflowRuntime): number {
  return workflow.config().orchestrator.task.timeouts.time_elapsed_minutes;
}

function noProgressSeconds(workflow: WorkflowRuntime): number {
  return workflow.config().orchestrator.task.timeouts.no_progress_minutes * 60;
}
