import type { PlanEntry, SessionUpdate, StopReason, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentActivityContent, SessionPlanItem } from "@artfct-ai/adapters/tracker/types";
import { hasChatThread } from "../../notify/recipients";
import { jobSessionOf, type TrackerSession } from "../inbound/job-session";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/** The closing reply after a stop or a cancel. */
export const STOPPED_TEXT = "Stopped.";

/** The closing reply after a finished turn when the author's last message is gone. */
export const DONE_TEXT = "Done.";

/** The most characters of the author's message the feed keeps for the closing reply. */
export const FEED_BODY_CHARS = 10_000;

/**
 * What the session feed holds in memory for one author's turn: the message since its last tool
 * call, and the title and kind of each tool call that did not complete yet.
 */
export type AuthorFeed = {
  message: string;
  tools: Map<string, { title: string; kind: ToolKind | null }>;
};

/**
 * How a turn ends the session feed: the author's last message as the reply, `STOPPED_TEXT` after a
 * stop, or an error that says why the turn did not finish.
 */
export type FeedClosing = { kind: "reply" } | { kind: "stopped" } | { kind: "error"; text: string };

/** The closing of a turn a person stopped, or of a task that was cancelled. */
export const STOPPED_CLOSING: FeedClosing = { kind: "stopped" };

const TOOL_VERBS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edited",
  delete: "Deleted",
  move: "Moved",
  search: "Searched",
  execute: "Ran",
  think: "Thought",
  fetch: "Fetched",
  switch_mode: "Switched mode",
  other: "Used",
};

/** The job session the author of a task streams to. Null for another role and without a session. */
function feedSessionOf(workflow: WorkflowRuntime, task: TaskRow): TrackerSession | null {
  if (task.role !== "author") return null;
  return jobSessionOf(workflow, workflow.store.requireJob(task.job_id));
}

function authorFeedOf(workflow: WorkflowRuntime, taskId: string): AuthorFeed {
  const existing = workflow.sessionFeeds.get(taskId);
  if (existing) return existing;
  const created: AuthorFeed = { message: "", tools: new Map() };
  workflow.sessionFeeds.set(taskId, created);
  return created;
}

/**
 * Feed one harness update of an author to its job session. A completed or failed tool call posts
 * one action. A message is kept for the closing reply until the next tool call. Thoughts are skipped.
 */
export async function streamToSessionFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  update: SessionUpdate,
): Promise<void> {
  const session = feedSessionOf(workflow, task);
  if (!session) return;
  const feed = authorFeedOf(workflow, task.task_id);
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type !== "text") return;
      feed.message = `${feed.message}${update.content.text}`.slice(0, FEED_BODY_CHARS);
      return;
    case "tool_call":
      feed.message = "";
      feed.tools.set(update.toolCallId, { title: update.title, kind: update.kind ?? null });
      return postEndedTool(workflow, { session, task, feed }, update);
    case "tool_call_update":
      return postEndedTool(workflow, { session, task, feed }, update);
    default:
      return;
  }
}

async function postEndedTool(
  workflow: WorkflowRuntime,
  target: { session: TrackerSession; task: TaskRow; feed: AuthorFeed },
  update: { toolCallId: string; title?: string | null; status?: string | null },
): Promise<void> {
  if (update.status !== "completed" && update.status !== "failed") return;
  const { session, task, feed } = target;
  const tool = feed.tools.get(update.toolCallId);
  feed.tools.delete(update.toolCallId);
  const title = update.title || tool?.title;
  if (!title) return;
  const content: AgentActivityContent = {
    type: "action",
    action: TOOL_VERBS[tool?.kind ?? "other"],
    parameter: title,
    ...(update.status === "failed" ? { result: "failed" } : {}),
  };
  await workflow.notifier.feed(session, task.task_id, content);
}

/** How a turn that leaves the author idle ends its session feed. */
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
 * The author's turn is over. Forget what the feed held for it, and post the closing when one is
 * given. A reply falls back to `DONE_TEXT` when the author's last message is gone.
 */
export async function closeSessionFeed(
  workflow: WorkflowRuntime,
  task: TaskRow,
  closing: FeedClosing | null,
): Promise<void> {
  const message = workflow.sessionFeeds.get(task.task_id)?.message ?? "";
  workflow.sessionFeeds.delete(task.task_id);
  const session = feedSessionOf(workflow, task);
  if (!session || !closing) return;
  await workflow.notifier.feed(session, task.task_id, closingContent(closing, message));
}

/**
 * The author's task ends for good while a prompt is in flight or queued, so no turn end will
 * close its session feed. Close it now.
 */
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
