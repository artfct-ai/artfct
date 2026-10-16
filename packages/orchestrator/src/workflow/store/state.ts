import type { Actor, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";

export type RequestText = { title: string; text: string; links: string[] };
export type RepoRef = { full: string };

/** One message a person wrote in a chat thread, which a reaction is addressed to. */
export type ChatMessageRef = { channel: string; message: string };

/**
 * The root page of a workflow. A `container` is the page the plan created under the page parent,
 * which the root page stage fills when it runs. A `named` page is an existing page a person named.
 */
export type RootPage = { page_id: string; url: string; source: "container" | "named" };

/**
 * The one issue or tracker project a workflow works on. An issue subject covers the issue and its
 * direct sub-issues. A project subject covers the project's issues.
 */
export type Subject = { kind: "issue"; issue_id: string } | { kind: "project"; project_id: string };

/** Durable state of one workflow. Small and JSON-shaped. Task rows live in SQLite. */
export type WorkflowState = {
  workflow_id: string;
  status: WorkflowStatus;
  starter: Actor | null;
  origin: ReplyTarget | null;
  reply_targets: ReplyTarget[];
  request: RequestText;
  /**
   * The name of the workflow definition the workflow runs. The plan that starts the workflow sets
   * it, and a later plan cannot change it. Null before that plan.
   */
  definition: string | null;
  /**
   * What the workflow works on, written once and never changed. Null until a tracker origin, the
   * plan, or the breakdown output sets it. Absent in a workflow stored before subjects.
   */
  subject?: Subject | null;
  /** The display name the plan gave the workflow. Empty until the first plan. */
  name: string;
  repo: RepoRef | null;
  /** The page parent the plan named. Absent in a workflow stored before the plan could name one. */
  page_parent?: string | null;
  /** The root page, once the plan made or named one. Absent in a workflow stored before root pages. */
  root_page?: RootPage | null;
  /** The planned stages in order. A guide for the agent, which may run any configured stage. */
  stages: string[];
  /** Tasks that may run at once. Set by the plan, capped by `sandbox.max_concurrency`. */
  concurrency: number;
  task_seq: number;
  /** The sequence of the last job. Absent in a workflow stored before jobs existed. */
  job_seq?: number;
  created_at: string;
  reason: string;
  /** When the agent turn now running began, or null between turns. Survives eviction. */
  turn_started_at: string | null;
  /** The schedule id of the turn watchdog alarm, or null between turns. */
  turn_watchdog: string | null;
  /**
   * The schedule id of the heads-up alarm of a turn on a person's message, or null. Absent in a
   * workflow stored before this field.
   */
  turn_heads_up?: string | null;
  /**
   * The id of the running turn's first transcript row, or the lost turn's in a resumed turn.
   * Compaction keeps it and every row after it. Null once a turn ends. Absent in a workflow
   * stored before this field.
   */
  turn_first_row?: number | null;
  /**
   * True once the running turn on a person's message, or the lost turn it resumes, started or
   * prompted a task in a workflow with a chat thread. A turn that resumes nothing starts it at
   * false. Absent in a workflow stored before this field.
   */
  turn_board_changed?: boolean;
  /** The schedule id of the idle alarm that posts the sleep note, or null. */
  idle_alarm: string | null;
};

export const initialWorkflowState: WorkflowState = {
  workflow_id: "",
  status: "new",
  starter: null,
  origin: null,
  reply_targets: [],
  request: { title: "", text: "", links: [] },
  definition: null,
  subject: null,
  name: "",
  repo: null,
  page_parent: null,
  root_page: null,
  stages: [],
  concurrency: 1,
  task_seq: 0,
  job_seq: 0,
  created_at: "",
  reason: "",
  turn_started_at: null,
  turn_watchdog: null,
  turn_heads_up: null,
  turn_first_row: null,
  turn_board_changed: false,
  idle_alarm: null,
};

/** What every reader calls the workflow. Never empty. Stored state may lack a name or a title. */
export function workflowName(state: { name?: string; request: RequestText }): string {
  return state.name || state.request.title || firstLine(state.request.text);
}

/** Workflow statuses a workflow never leaves. */
export const FINISHED_WORKFLOW_STATUSES: WorkflowStatus[] = ["done", "cancelled", "failed"];

/** True when the workflow ended. It stays ended: every later event gets the finished reply or is dropped. */
export function isWorkflowFinished(status: WorkflowStatus): boolean {
  return FINISHED_WORKFLOW_STATUSES.includes(status);
}

/** Task statuses that accept no more prompts. */
export const FINISHED_TASK_STATUSES: TaskStatus[] = ["done", "cancelled", "failed"];

/** True once the task will accept no more prompts. */
export function isTaskFinished(status: TaskStatus): boolean {
  return FINISHED_TASK_STATUSES.includes(status);
}

/** The current time as the ISO string every stored timestamp column holds. */
export function now(): string {
  return new Date().toISOString();
}

/** A title for requests that arrive without one, or with an empty one. */
export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim().slice(0, 120) || "task";
}
