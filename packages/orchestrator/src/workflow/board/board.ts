import type { PlanEntry } from "@agentclientprotocol/sdk";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { sequenceFromJobId } from "../../ids";
import {
  judgeRejected,
  refinerIndexOf,
  refinerRunOf,
  reviewerEntryOf,
} from "../refiner/stage-refiner";
import { workflowName } from "../store/state";
import type { TodoRow } from "./board-store";
import type { ArtifactRow, JobRow, TaskRow } from "../store/tasks";
import { authorBusy } from "../follow-up";
import type { WorkflowRuntime } from "../types";
import { publishBoard } from "./publish";
import { boardText, renderBoard } from "./render";
import type {
  BoardChannel,
  BoardFormat,
  BoardInput,
  BoardTask,
  RefinerBoard,
  RefinerPhase,
  RefinerPhaseView,
} from "./types";

/** Changes within this window after the first one go out in one edit. */
export const BOARD_COALESCE_S = 10;
const NAME_CHARS = 60;

/** The payload of the flush alarm: the job whose boards flush. */
export type BoardAlarm = { job_id: string };

/**
 * Boards being posted now and jobs whose flush alarm is being created now, per runtime.
 * Neither outlives the isolate, so neither is stored.
 */
const inFlight = new WeakMap<WorkflowRuntime, { writing: Set<string>; scheduling: Set<string> }>();

function inFlightSets(workflow: WorkflowRuntime) {
  const existing = inFlight.get(workflow);
  if (existing) return existing;
  const created = { writing: new Set<string>(), scheduling: new Set<string>() };
  inFlight.set(workflow, created);
  return created;
}

/** The board key of a channel: one board per chat thread or tracker issue. */
export function channelKey(channel: BoardChannel): string {
  switch (channel.source) {
    case "chat":
      return `chat:${channel.channel}:${channel.thread}`;
    case "tracker":
      return `tracker:${channel.issue_id}`;
    default: {
      const unhandled: never = channel;
      throw new Error(`unhandled board channel ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The task as the board and the digest see it, numbered by its job. A refiner run works on a
 * phase where an author or a researcher works on a stage.
 */
export function boardTask(workflow: WorkflowRuntime, task: TaskRow): BoardTask {
  const job = workflow.store.requireJob(task.job_id);
  return {
    task_id: task.task_id,
    number: sequenceFromJobId(job.job_id) ?? 0,
    ticket_key: job.issue_key,
    workflow_name: boardText(workflowName(workflow.state)).slice(0, NAME_CHARS),
    work: boardWork(task, job),
    status: task.status,
    paused: task.paused_at !== null,
    started_at: task.started_at,
  };
}

function boardWork(task: TaskRow, job: JobRow): BoardTask["work"] {
  switch (task.role) {
    case "reviewer":
    case "polisher":
      return { phase: phaseOf(task) };
    case "author":
    case "researcher":
      break;
  }
  return { stage: job.stage };
}

/** Alarm: the coalescing window closed. */
export async function onFlushBoard(workflow: WorkflowRuntime, alarm: BoardAlarm): Promise<void> {
  const task = workflow.store.authorOrResearcherTaskOf(alarm.job_id);
  workflow.store.patchTodoRow(task.task_id, { flush_schedule: null });
  await flushBoards(workflow, alarm.job_id);
}

/**
 * Bring every board of the job up to date now, creating one that does not exist yet. The board
 * shows the todo list of the author, or of the researcher before the author starts, and where
 * the refiner runs of the job stand.
 */
export async function flushBoards(workflow: WorkflowRuntime, jobId: string): Promise<void> {
  const job = workflow.store.requireJob(jobId);
  const task = workflow.store.authorOrResearcherTaskOf(jobId);
  const row = await dropBoardFlush(workflow, task.task_id);
  const artifact = workflow.store.artifact(jobId);
  const followUp = followUpStatus(workflow, task, artifact);
  const input: BoardInput = {
    task: boardTask(workflow, task),
    todos: row.todos,
    note: row.note,
    refiners: refinerBoard(workflow, job, followUp),
    artifact_status: artifact?.status ?? null,
    follow_up: followUp,
    now: workflow.now(),
  };
  for (const channel of boardChannels(workflow, job)) {
    await flushOne(workflow, jobId, channel, input);
  }
}

/** One board of the job. A board being written now is flushed again after that write ends. */
async function flushOne(
  workflow: WorkflowRuntime,
  jobId: string,
  channel: BoardChannel,
  input: BoardInput,
): Promise<void> {
  const key = channelKey(channel);
  const { writing } = inFlightSets(workflow);
  const writeKey = `${jobId} ${key}`;
  if (writing.has(writeKey)) {
    await markBoardDirty(workflow, jobId);
    return;
  }
  const row = workflow.store.board(jobId, key) ?? workflow.store.insertBoard(jobId, key, channel);
  const { body, text } = renderBoard(input, formatFor(channel));
  writing.add(writeKey);
  try {
    await publishBoard({ workflow, row, text, hash: hashText(body) });
  } finally {
    writing.delete(writeKey);
  }
}

/**
 * Cancel the flush alarm pending on the task's todo row and clear it. For a flush that covers it,
 * and for a researcher whose board the author takes over. Returns the row.
 */
export async function dropBoardFlush(workflow: WorkflowRuntime, taskId: string): Promise<TodoRow> {
  const pending = workflow.store.todoRow(taskId)?.flush_schedule;
  if (pending) await cancelFlush(workflow, taskId, pending);
  return workflow.store.patchTodoRow(taskId, { flush_schedule: null });
}

/** Drop the pending alarm because this flush covers it. Logs and never throws. */
async function cancelFlush(workflow: WorkflowRuntime, taskId: string, alarmId: string) {
  try {
    await workflow.cancelAlarm(alarmId);
  } catch (error) {
    workflow.log(taskId, `board flush alarm not cancelled: ${String(error)}`);
  }
}

/**
 * Where the follow-ups stand. Any work after the first handover is one. In progress while the
 * humans hold the artifact and the author works on it. Null before the first handover.
 */
function followUpStatus(
  workflow: WorkflowRuntime,
  author: TaskRow,
  artifact: ArtifactRow | null,
): PlanEntry["status"] | null {
  if (!artifact?.delivered_to_humans_at) return null;
  const working = artifact.status === "ready" && authorBusy(workflow, author);
  return working ? "in_progress" : "completed";
}

/**
 * Where the stage's phases stand on the job's artifact: review, then polish. Null without an
 * artifact or on a stage that declares neither. The pointer decides: the phase of its refiner is
 * open, review is done once a polisher holds the artifact, and an artifact past the refiners
 * reads done throughout. A follow-up in progress or a reopened artifact reads live.
 */
function refinerBoard(
  workflow: WorkflowRuntime,
  job: JobRow,
  followUp: PlanEntry["status"] | null,
): RefinerBoard | null {
  const artifact = workflow.store.artifact(job.job_id);
  if (!artifact) return null;
  const stage = workflow.stageFor(job);
  const phases: RefinerPhase[] = [];
  if (stage.reviewers.length) phases.push("review");
  if (stage.polishers.length) phases.push("polish");
  if (!phases.length) return null;
  const pointer = refinerRunOf(workflow, artifact);
  const open = pointer ? phaseOf(pointer) : null;
  const past = artifact.status !== "drafted" && followUp !== "in_progress";
  return {
    phases: phases.map((phase): RefinerPhaseView => {
      if (past || (phase === "review" && open === "polish")) return { phase, status: "completed" };
      if (!pointer || phase !== open) return { phase, status: "pending" };
      return {
        phase,
        status: "in_progress",
        run: phaseRunOf(workflow, pointer),
        refiner_status: pointer.status,
        ruling: reviewerEntryOf(workflow, pointer)?.mode === "judge" ? openRulingOf(pointer) : null,
      };
    }),
    humans: past ? "completed" : "pending",
  };
}

/** The phase a refiner run belongs to. A refiner run shows it in place of a stage name. */
function phaseOf(run: TaskRow): RefinerPhase {
  return run.role === "polisher" ? "polish" : "review";
}

/** Which run of its phase a refiner run is in: the most runs any entry of the phase has had. */
function phaseRunOf(workflow: WorkflowRuntime, run: TaskRow): number {
  const runsByEntry = new Map<number, number>();
  for (const sibling of workflow.store.refinerRunsOf(run.job_id)) {
    if (sibling.role !== run.role) continue;
    const index = refinerIndexOf(sibling);
    runsByEntry.set(index, (runsByEntry.get(index) ?? 0) + 1);
  }
  return Math.max(1, ...runsByEntry.values());
}

/** Where a judge reviewer's ruling stands while its entry is still open. Null while it runs. */
function openRulingOf(judge: TaskRow): "awaited" | "rejected" | null {
  if (judge.status !== "done") return null;
  return judgeRejected(judge) ? "rejected" : "awaited";
}

/**
 * Something on the job's board changed. Flush soon, so a burst of changes goes out as one edit.
 * The pending alarm is kept on the todo row of the task the board shows. Never throws: a failed
 * schedule is logged and tried again.
 */
export async function markBoardDirty(workflow: WorkflowRuntime, jobId: string): Promise<void> {
  const task = workflow.store.authorOrResearcherTaskOf(jobId);
  if (workflow.store.todoRow(task.task_id)?.flush_schedule) return;
  const { scheduling } = inFlightSets(workflow);
  if (scheduling.has(jobId)) return;
  scheduling.add(jobId);
  try {
    const alarm: BoardAlarm = { job_id: jobId };
    const id = await workflow.scheduleAlarm(BOARD_COALESCE_S, "flushBoard", alarm);
    workflow.store.patchTodoRow(task.task_id, { flush_schedule: id });
  } catch (error) {
    workflow.log(task.task_id, `board flush not scheduled: ${String(error)}`);
  } finally {
    scheduling.delete(jobId);
  }
}

/** Every reply target that can hold a board of the job, one board per place. */
function boardChannels(workflow: WorkflowRuntime, job: JobRow): BoardChannel[] {
  const channels = new Map<string, BoardChannel>();
  for (const target of workflow.state.reply_targets) {
    const channel = channelFor(target, job);
    if (channel) channels.set(channelKey(channel), channel);
  }
  return [...channels.values()];
}

/** A tracker board sits on the job's own issue, so several sessions share one board. */
function channelFor(target: ReplyTarget, job: JobRow): BoardChannel | null {
  switch (target.source) {
    case "chat":
      return { source: "chat", channel: target.channel, thread: target.thread };
    case "tracker":
      return { source: "tracker", issue_id: job.issue_id ?? target.issue_id };
    case "docs":
    case "code":
      return null;
    default: {
      const unhandled: never = target;
      throw new Error(`unhandled reply target ${JSON.stringify(unhandled)}`);
    }
  }
}

function formatFor(channel: BoardChannel): BoardFormat {
  return channel.source === "chat" ? "chat" : "markdown";
}

/** FNV-1a over the text, as hex. Enough to tell "unchanged" from "changed". */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
