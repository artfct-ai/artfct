import type { PlanEntry, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { SessionPlanItem } from "@artfct-ai/adapters/tracker/types";
import { hasChatThread } from "../../notify/recipients";
import { jobSessionOf, type TrackerSession } from "../inbound/job-session";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";
import { renderFeed } from "./render";
import type { FeedClosing, FeedItem } from "./types";

/** A session feed posts at most once in this window, besides the activities that close a turn. */
export const FEED_INTERVAL_MS = 15_000;

/** The closing reply after a stop when the author said nothing after its last tool call. */
export const STOPPED_TEXT = "Stopped.";

/** The closing reply after a finished turn when the author said nothing after its last tool call. */
export const DONE_TEXT = "Done.";

/**
 * When each job session last got a feed post, and the flush of each task that runs now. Neither
 * outlives the isolate, so neither is stored. A lost time only lets one flush come early.
 */
const feedTimes = new WeakMap<
  WorkflowRuntime,
  { postedAt: Map<string, number>; flushing: Map<string, Promise<void>> }
>();

function feedTimesOf(workflow: WorkflowRuntime) {
  const existing = feedTimes.get(workflow);
  if (existing) return existing;
  const created = {
    postedAt: new Map<string, number>(),
    flushing: new Map<string, Promise<void>>(),
  };
  feedTimes.set(workflow, created);
  return created;
}

/** The job session the author of a task streams to. Null for another role and without a session. */
function feedSessionOf(workflow: WorkflowRuntime, task: TaskRow): TrackerSession | null {
  if (task.role !== "author") return null;
  return jobSessionOf(workflow, workflow.store.requireJob(task.job_id));
}

/** Keep one harness update of an author for its session feed. Updates the feed does not show are dropped. */
export function recordFeedUpdate(
  workflow: WorkflowRuntime,
  task: TaskRow,
  update: SessionUpdate,
): void {
  if (!feedSessionOf(workflow, task)) return;
  const { store } = workflow;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return;
      const kind = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
      store.appendFeedText(task.task_id, kind, update.content.text);
      return;
    }
    case "tool_call":
      store.addFeedTool(task.task_id, {
        tool_call_id: update.toolCallId,
        title: update.title,
        tool_kind: update.kind ?? null,
      });
      return;
    case "tool_call_update":
      store.updateFeedTool(task.task_id, update.toolCallId, {
        ...(update.title ? { title: update.title } : {}),
        failed: update.status === "failed",
      });
      return;
    default:
      return;
  }
}

/** How a turn that leaves the author idle closes its feed. */
export function feedClosingOf(stopReason: StopReason): FeedClosing {
  switch (stopReason) {
    case "end_turn":
      return { kind: "reply", fallback: DONE_TEXT };
    case "cancelled":
      return { kind: "reply", fallback: STOPPED_TEXT };
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

/** The items a flush posts. Text the harness may still stream into stays until it is followed. */
function settledItems(items: FeedItem[]): FeedItem[] {
  const last = items.at(-1);
  return last && last.kind !== "tool" ? items.slice(0, -1) : items;
}

/** Add the closing item when the last item cannot close the turn itself. */
function addClosingItem(workflow: WorkflowRuntime, taskId: string, closing: FeedClosing): void {
  const { store } = workflow;
  if (closing.kind === "error") return store.appendFeedText(taskId, "error", closing.text);
  if (store.feedItems(taskId).at(-1)?.kind === "message") return;
  store.appendFeedText(taskId, "message", closing.fallback);
}

/** Render the items a flush posts into pending posts. A closing replaces posts that failed before it. */
function queueFlush(workflow: WorkflowRuntime, taskId: string, closing: FeedClosing | null): void {
  const { store } = workflow;
  if (closing) {
    store.deleteFeedPosts(taskId);
    addClosingItem(workflow, taskId, closing);
    store.queueFeedPosts(taskId, renderFeed(store.feedItems(taskId), true));
    return;
  }
  if (store.feedPosts(taskId).length > 0) return;
  store.queueFeedPosts(taskId, renderFeed(settledItems(store.feedItems(taskId)), false));
}

async function postFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  closing: FeedClosing | null,
): Promise<void> {
  const session = feedSessionOf(workflow, task);
  if (!session) return;
  const { postedAt } = feedTimesOf(workflow);
  const now = workflow.now();
  const last = postedAt.get(session.session_id);
  if (!closing && last !== undefined && now - last < FEED_INTERVAL_MS) return;
  queueFlush(workflow, task.task_id, closing);
  const pending = workflow.store.feedPosts(task.task_id);
  const posts = closing ? pending : pending.slice(0, 1);
  for (const [index, post] of posts.entries()) {
    postedAt.set(session.session_id, now);
    const posted = await workflow.notifier.feed(session, task.task_id, post);
    const beforeClosing = closing !== null && index < posts.length - 1;
    if (!posted && !beforeClosing) return;
    workflow.store.deleteFeedPost(post.seq);
  }
}

/**
 * Post the author's settled feed items to its job session, at most once in `FEED_INTERVAL_MS` per
 * session. A closing posts everything at once and ends with the closing reply or error, after any
 * flush that runs now. A failed post is retried later with the same id and content, except one
 * that fails before a closing: it is dropped, so the closing still ends the turn.
 */
export async function flushFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  closing: FeedClosing | null = null,
): Promise<void> {
  const { flushing } = feedTimesOf(workflow);
  const running = flushing.get(task.task_id);
  if (running && !closing) return;
  const flush = (running ?? Promise.resolve()).then(() => postFeed(workflow, task, closing));
  flushing.set(task.task_id, flush);
  try {
    await flush;
  } finally {
    if (flushing.get(task.task_id) === flush) flushing.delete(task.task_id);
  }
}

const PLAN_STATUSES: Record<PlanEntry["status"], SessionPlanItem["status"]> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

/** A todo list as a session plan. */
export function sessionPlanOf(entries: PlanEntry[]): SessionPlanItem[] {
  return entries.map((entry) => ({ content: entry.content, status: PLAN_STATUSES[entry.status] }));
}

/**
 * Show the author's todo list as the plan of its job session. A workflow with a chat thread keeps
 * the list on its chat board only.
 */
export async function publishSessionPlan(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  if (hasChatThread(workflow.state)) return;
  const session = feedSessionOf(workflow, task);
  const entries = workflow.store.todoRow(task.task_id)?.todos?.entries;
  if (!session || !entries) return;
  await workflow.notifier.sessionPlan(session, sessionPlanOf(entries));
}
