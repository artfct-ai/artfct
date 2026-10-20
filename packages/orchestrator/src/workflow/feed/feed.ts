import type { PlanEntry, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { AgentActivityContent, SessionPlanItem } from "@artfct-ai/adapters/tracker/types";
import type { FeedActivity } from "../../notify/notifier";
import { hasChatThread } from "../../notify/recipients";
import { authorInSession, jobSessionOf, type TrackerSession } from "../inbound/job-session";
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

/**
 * How long the session feed retries what did not land after a turn. Narration waits until the feed
 * has been quiet this long, and a closing reply until this long after its turn ended.
 */
export const FEED_GIVES_UP_AFTER_MS = 60 * 60_000;

/** The share of the request quota below which heartbeats are skipped and narration waits. */
const LOW_QUOTA_SHARE = 0.1;

/** The receipt a person gets when their message reaches a running workflow. */
export const RECEIPT_TEXT = "Got it. Working on your message.";

/** The heartbeat of a turn whose todo list names no step in progress. */
export const STILL_WORKING_TEXT = "Still working.";

/**
 * The payload of a closing reply's alarm: the job session, the reply under its activity id, and
 * when its turn ended.
 */
export type ClosingReplyAlarm = {
  session: TrackerSession;
  activity: FeedActivity;
  ended_at: string;
};

/**
 * What the session feed keeps in memory during one author turn: the text since the last tool
 * call, and the narration post that is out, which the next one waits for.
 */
export type AuthorFeed = { message: string; narrationPost: Promise<void> };

/**
 * How the session feed ends a turn. `narrated_account` is the turn end of an author that goes
 * straight into its next turn: its closing account posts as narration, not as a response.
 */
export type FeedClosing =
  | { kind: "reply" }
  | { kind: "narrated_account" }
  | { kind: "stopped" }
  | { kind: "error"; text: string };

/** A closing that posts as a response or an error and ends the feed's turn. */
type PostedClosing = Exclude<FeedClosing, { kind: "narrated_account" }>;

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

/** When waiting narration posts: once it is due, or now, as a turn ends. */
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
  if (time === "when_due" && !(await narrationDue(workflow, waiting))) return;
  const session = feedSessionOf(workflow, task);
  if (!session) return;
  const posted = await workflow.notifier.feed(session, {
    task_id: task.task_id,
    id: crypto.randomUUID(),
    content: { type: "thought", body: waiting.narration },
  });
  if (posted) workflow.store.recordNarrationPost(task.task_id, waiting.narration, isoNow(workflow));
}

/** Narration is due once its interval has passed, while the request quota is not low. */
async function narrationDue(workflow: WorkflowRuntime, feed: SessionFeedRow): Promise<boolean> {
  const sinceLastPost =
    feed.narrated_at === null ? Infinity : workflow.now() - Date.parse(feed.narrated_at);
  return sinceLastPost >= NARRATION_INTERVAL_MS && !(await requestQuotaLow(workflow));
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
 * Alarm: post the narration that is due, and a heartbeat after a quiet stretch of a turn. The tick
 * outlives the turn while narration waits, such as after a turn end the tracker failed, until the
 * feed has been quiet for an hour.
 */
export async function tendSessionFeed(workflow: WorkflowRuntime, alarm: TaskAlarm): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const inTurn =
    !!task &&
    !isTaskFinished(task.status) &&
    workflow.store.sandbox(alarm.task_id)?.prompt_in_flight === 1;
  const feed = workflow.store.sessionFeed(alarm.task_id);
  const narrationWaits = !!feed?.narration;
  const quiet = !!feed && workflow.now() - Date.parse(feed.active_at) >= FEED_GIVES_UP_AFTER_MS;
  if (!task || (!inTurn && !narrationWaits)) {
    await workflow.stopRepeatingAlarm("tendSessionFeed", alarm);
    return;
  }
  if (!inTurn && quiet) {
    workflow.log(task.task_id, "narration given up: the session feed was quiet for an hour");
    await workflow.stopRepeatingAlarm("tendSessionFeed", alarm);
    return;
  }
  await postWaitingNarration(workflow, task, "when_due");
  if (inTurn) await postHeartbeatAfterQuiet(workflow, task);
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
  await workflow.notifier.ephemeralThought(session, heartbeatText(workflow, task));
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

/**
 * Tell a person in a tracker session that their message reached the workflow. It counts as
 * activity of the session's author.
 */
export async function postReceipt(
  workflow: WorkflowRuntime,
  session: TrackerSession,
): Promise<void> {
  await workflow.notifier.ephemeralThought(session, RECEIPT_TEXT);
  const author = authorInSession(workflow, session);
  if (author && workflow.store.sessionFeed(author.task_id)) {
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

/**
 * The closing of a turn whose author goes straight into its next turn. A response would mark the
 * job session complete while the work goes on, so the reply's account posts as narration. A stop
 * or an error does not post.
 */
export function closingWhenTheAuthorGoesOn(closing: FeedClosing): FeedClosing | null {
  return closing.kind === "reply" ? { kind: "narrated_account" } : null;
}

function closingContent(closing: PostedClosing, message: string): AgentActivityContent {
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
 * End the author's session feed for this turn, and post the closing when one is given. A turn end
 * counts as activity, and a narrated account joins the narration that waits. The reply's alarm is
 * armed before the post and cancelled once the reply lands, so a failed post or an instance
 * restart does not lose the reply.
 */
export async function closeSessionFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  closing: FeedClosing | null,
): Promise<void> {
  if (workflow.store.sessionFeed(task.task_id)) {
    workflow.store.touchSessionFeed(task.task_id, isoNow(workflow));
  }
  const message = workflow.sessionFeeds.get(task.task_id)?.message ?? "";
  const account = closing?.kind === "narrated_account" ? message.trim() : "";
  if (account) workflow.store.appendNarration(task.task_id, account, isoNow(workflow));
  await postWaitingNarration(workflow, task, "now");
  workflow.sessionFeeds.delete(task.task_id);
  const session = feedSessionOf(workflow, task);
  if (!session || !closing || closing.kind === "narrated_account") return;
  const content = closingContent(closing, message);
  const reply: ClosingReplyAlarm = {
    session,
    activity: { task_id: task.task_id, id: crypto.randomUUID(), content },
    ended_at: isoNow(workflow),
  };
  const alarm = await workflow.scheduleAlarm(
    CLOSING_REPLY_ALARM_SECONDS,
    "postClosingReply",
    reply,
  );
  if (await postReplyAfterNarration(workflow, reply)) await workflow.cancelAlarm(alarm);
}

/**
 * Alarm: post the narration that waits, then the closing reply under its activity id, so the
 * tracker stores it once however often it posts. A failed post arms the alarm again, until an
 * hour after the turn ended.
 */
export async function postClosingReply(
  workflow: WorkflowRuntime,
  reply: ClosingReplyAlarm,
): Promise<void> {
  const task = workflow.store.task(reply.activity.task_id);
  if (task) await postWaitingNarration(workflow, task, "now");
  if (await postReplyAfterNarration(workflow, reply)) return;
  if (workflow.now() - Date.parse(reply.ended_at) >= FEED_GIVES_UP_AFTER_MS) {
    workflow.log(reply.activity.task_id, "closing reply given up an hour after its turn ended");
    return;
  }
  await workflow.scheduleAlarm(CLOSING_REPLY_ALARM_SECONDS, "postClosingReply", reply);
}

/**
 * Post a closing reply once no narration of its author waits, so the reply is the last line of its
 * turn. True once the tracker took it.
 */
async function postReplyAfterNarration(
  workflow: WorkflowRuntime,
  reply: ClosingReplyAlarm,
): Promise<boolean> {
  if (workflow.store.sessionFeed(reply.activity.task_id)?.narration) return false;
  return workflow.notifier.feed(reply.session, reply.activity);
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
  if (hasChatThread(workflow.store.replyTargets())) return;
  const session = feedSessionOf(workflow, task);
  const entries = workflow.store.todoRow(task.task_id)?.todos?.entries;
  if (!session || !entries) return;
  await workflow.notifier.sessionPlan(session, sessionPlanOf(entries));
}
