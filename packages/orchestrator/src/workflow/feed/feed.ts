import type { PlanEntry, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { AgentActivityContent, SessionPlanItem } from "@artfct-ai/adapters/tracker/types";
import type { FeedActivity } from "../../notify/notifier";
import { hasChatThread } from "../../notify/recipients";
import { jobSessionOf, type TrackerSession } from "../inbound/job-session";
import { isTaskFinished } from "../store/state";
import type { SessionFeedRow, TaskRow } from "../store/tasks";
import type { TaskAlarm } from "../task/harness/timers";
import type { WorkflowRuntime } from "../types";

/** The closing reply of a stopped turn. */
export const STOPPED_TEXT = "Stopped.";

/** The closing reply of a finished turn without a last message, such as a lost one or a model call. */
export const DONE_TEXT = "Done.";

/** The longest author message the feed keeps for the closing reply. */
const FEED_BODY_CHARS = 10_000;

/** How long a closing reply's alarm waits to post the reply again. Longer than the notifier's attempts take. */
const CLOSING_REPLY_ALARM_SECONDS = 60;

/** The least time between two narration posts of one author, except the post at a turn end. */
export const NARRATION_INTERVAL_MS = 5 * 60_000;

/** How long a turn goes without activity in its job session before a heartbeat posts. */
export const HEARTBEAT_AFTER_MS = 25 * 60_000;

/** How often the session feed of a turn in flight looks for narration that is due and for quiet. */
export const SESSION_FEED_TICK_SECONDS = 60;

/** The share of the request quota below which the feed skips heartbeats. */
const LOW_QUOTA_SHARE = 0.1;

/** The receipt a person gets when their message reaches a running author. */
export const RECEIPT_TEXT = "Got it. Working on your message.";

/** The heartbeat of a turn whose todo list names no step in progress. */
export const STILL_WORKING_TEXT = "Still working.";

/** The payload of a closing reply's alarm: the job session and the reply under its activity id. */
export type ClosingReplyAlarm = { session: TrackerSession; activity: FeedActivity };

/**
 * What the session feed keeps in memory during one author turn: the text since the last tool
 * call, and the narration post that is out, which the next one waits for.
 */
export type AuthorFeed = { message: string; narrationPost: Promise<void> };

/** How the session feed ends a turn. */
export type FeedClosing = { kind: "reply" } | { kind: "stopped" } | { kind: "error"; text: string };

/** The closing of a stopped turn or a cancelled task. */
export const STOPPED_CLOSING: FeedClosing = { kind: "stopped" };

function feedSessionOf(workflow: WorkflowRuntime, task: TaskRow): TrackerSession | null {
  if (task.role !== "author") return null;
  return jobSessionOf(workflow, workflow.store.requireJob(task.job_id));
}

function authorFeedOf(workflow: WorkflowRuntime, taskId: string): AuthorFeed {
  const existing = workflow.sessionFeeds.get(taskId);
  if (existing) return existing;
  const created: AuthorFeed = { message: "", narrationPost: Promise.resolve() };
  workflow.sessionFeeds.set(taskId, created);
  return created;
}

/**
 * Keep the author's message for the closing reply. A tool call makes the message before it a
 * narration line, which posts once its interval has passed.
 */
export async function streamToSessionFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  update: SessionUpdate,
): Promise<void> {
  if (!feedSessionOf(workflow, task)) return;
  const feed = authorFeedOf(workflow, task.task_id);
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type !== "text") return;
      feed.message = `${feed.message}${update.content.text}`.slice(0, FEED_BODY_CHARS);
      return;
    case "tool_call": {
      const line = feed.message.trim();
      feed.message = "";
      if (!line) return;
      workflow.store.appendNarration(task.task_id, line, isoNow(workflow));
      return postWaitingNarration(workflow, task, "when_due");
    }
    default:
      return;
  }
}

/** When waiting narration posts: once its interval has passed, or now, as a turn ends. */
type NarrationPostTime = "when_due" | "now";

/** Post the narration that waits, after the narration post that is out returns. */
function postWaitingNarration(
  workflow: WorkflowRuntime,
  task: TaskRow,
  time: NarrationPostTime,
): Promise<void> {
  const feed = authorFeedOf(workflow, task.task_id);
  const posted = feed.narrationPost.then(() => postNarrationNow(workflow, task, time));
  feed.narrationPost = posted.catch(() => undefined);
  return posted;
}

async function postNarrationNow(
  workflow: WorkflowRuntime,
  task: TaskRow,
  time: NarrationPostTime,
): Promise<void> {
  const waiting = workflow.store.sessionFeed(task.task_id);
  if (!waiting?.narration) return;
  if (time === "when_due" && !narrationDue(waiting, workflow.now())) return;
  const session = feedSessionOf(workflow, task);
  if (!session) return;
  const posted = await workflow.notifier.feed(session, {
    task_id: task.task_id,
    id: crypto.randomUUID(),
    content: { type: "thought", body: waiting.narration },
    ephemeral: false,
  });
  if (posted) workflow.store.recordNarrationPost(task.task_id, waiting.narration, isoNow(workflow));
}

function narrationDue(feed: SessionFeedRow, now: number): boolean {
  return feed.narrated_at === null || now - Date.parse(feed.narrated_at) >= NARRATION_INTERVAL_MS;
}

function isoNow(workflow: WorkflowRuntime): string {
  return new Date(workflow.now()).toISOString();
}

/** A turn of the author went in flight. Its start counts as activity, and the feed's tick runs. */
export async function startSessionFeedTurn(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<void> {
  if (!feedSessionOf(workflow, task)) return;
  workflow.store.touchSessionFeed(task.task_id, isoNow(workflow));
  const alarm: TaskAlarm = { task_id: task.task_id };
  await workflow.startRepeatingAlarm(SESSION_FEED_TICK_SECONDS, "tendSessionFeed", alarm);
}

/**
 * Alarm: post the narration that is due, and a heartbeat after a quiet stretch. The tick stops
 * once no turn of the author is in flight.
 */
export async function tendSessionFeed(workflow: WorkflowRuntime, alarm: TaskAlarm): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const inFlight = workflow.store.sandbox(alarm.task_id)?.prompt_in_flight === 1;
  if (!task || !inFlight || isTaskFinished(task.status)) {
    await workflow.stopRepeatingAlarm("tendSessionFeed", alarm);
    return;
  }
  await postWaitingNarration(workflow, task, "when_due");
  await postHeartbeatAfterQuiet(workflow, task);
}

async function postHeartbeatAfterQuiet(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  const feed = workflow.store.sessionFeed(task.task_id);
  const session = feedSessionOf(workflow, task);
  if (!feed || !session) return;
  if (workflow.now() - Date.parse(feed.active_at) < HEARTBEAT_AFTER_MS) return;
  if (await requestQuotaLow(workflow)) {
    workflow.log(task.task_id, "heartbeat skipped: the tracker's request quota is low");
    return;
  }
  await workflow.notifier.feed(session, {
    task_id: task.task_id,
    id: crypto.randomUUID(),
    content: { type: "thought", body: heartbeatText(workflow, task) },
    ephemeral: true,
  });
  workflow.store.touchSessionFeed(task.task_id, isoNow(workflow));
}

/** True while the tracker's last answer said less than a tenth of its request quota is left. */
async function requestQuotaLow(workflow: WorkflowRuntime): Promise<boolean> {
  const quota = (await workflow.tracker())?.requestQuota();
  if (!quota || workflow.now() >= quota.resets_at) return false;
  return quota.remaining < quota.limit * LOW_QUOTA_SHARE;
}

/** The heartbeat names the step of the author's todo list in progress. */
function heartbeatText(workflow: WorkflowRuntime, task: TaskRow): string {
  const entries = workflow.store.todoRow(task.task_id)?.todos?.entries ?? [];
  const current = entries.find((entry) => entry.status === "in_progress");
  return current ? `Working on: ${current.content}` : STILL_WORKING_TEXT;
}

/** Tell a person in a job session that their message reached its running author. */
export async function postReceipt(
  workflow: WorkflowRuntime,
  author: TaskRow,
  session: TrackerSession,
): Promise<void> {
  await workflow.notifier.feed(session, {
    task_id: author.task_id,
    id: crypto.randomUUID(),
    content: { type: "thought", body: RECEIPT_TEXT },
    ephemeral: true,
  });
  if (workflow.store.sessionFeed(author.task_id)) {
    workflow.store.touchSessionFeed(author.task_id, isoNow(workflow));
  }
}

/** The closing for a turn that ended with this stop reason. */
export function feedClosingOf(stopReason: StopReason): FeedClosing {
  switch (stopReason) {
    case "end_turn":
      return { kind: "reply" };
    case "cancelled":
      return STOPPED_CLOSING;
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return {
        kind: "error",
        text: `The turn ended on ${stopReason} before the work was complete.`,
      };
    default: {
      const unhandled: never = stopReason;
      throw new Error(`unhandled stop reason ${String(unhandled)}`);
    }
  }
}

function closingContent(closing: FeedClosing, message: string): AgentActivityContent {
  switch (closing.kind) {
    case "reply":
      return { type: "response", body: message || DONE_TEXT };
    case "stopped":
      return { type: "response", body: STOPPED_TEXT };
    case "error":
      return { type: "error", body: closing.text };
    default: {
      const unhandled: never = closing;
      throw new Error(`unhandled feed closing ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * End the author's session feed for this turn, and post the closing when one is given. The
 * reply's alarm is armed before the post and cancelled once it returns, so an instance restart
 * in between does not lose the reply.
 */
export async function closeSessionFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  closing: FeedClosing | null,
): Promise<void> {
  const message = workflow.sessionFeeds.get(task.task_id)?.message ?? "";
  await postWaitingNarration(workflow, task, "now");
  workflow.sessionFeeds.delete(task.task_id);
  const session = feedSessionOf(workflow, task);
  if (!session || !closing) return;
  const content = closingContent(closing, message);
  const reply: ClosingReplyAlarm = {
    session,
    activity: { task_id: task.task_id, id: crypto.randomUUID(), content, ephemeral: false },
  };
  const alarm = await workflow.scheduleAlarm(
    CLOSING_REPLY_ALARM_SECONDS,
    "postClosingReply",
    reply,
  );
  await postClosingReply(workflow, reply);
  await workflow.cancelAlarm(alarm);
}

/** Post a closing reply under its activity id, so the tracker stores it once however often it posts. */
export async function postClosingReply(
  workflow: WorkflowRuntime,
  reply: ClosingReplyAlarm,
): Promise<void> {
  await workflow.notifier.feed(reply.session, reply.activity);
}

/** Close the session feed of an author task that ends for good in the middle of a turn. */
export async function closeAbandonedTurnFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  closing: FeedClosing,
): Promise<void> {
  const inFlight = workflow.store.sandbox(task.task_id)?.prompt_in_flight === 1;
  if (!inFlight && !workflow.store.peekPrompt(task.task_id)) return;
  await closeSessionFeed(workflow, task, closing);
}

const PLAN_STATUSES: Record<PlanEntry["status"], SessionPlanItem["status"]> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

/** Map a todo list to a session plan. */
export function sessionPlanOf(entries: PlanEntry[]): SessionPlanItem[] {
  return entries.map((entry) => ({ content: entry.content, status: PLAN_STATUSES[entry.status] }));
}

/** As the author's turn ends, show its todo list as the plan of its job session when there is no chat thread. */
export async function publishSessionPlan(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  if (hasChatThread(workflow.state)) return;
  const session = feedSessionOf(workflow, task);
  const entries = workflow.store.todoRow(task.task_id)?.todos?.entries;
  if (!session || !entries) return;
  await workflow.notifier.sessionPlan(session, sessionPlanOf(entries));
}
