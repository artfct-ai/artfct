import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskStatus, WorkflowStatus } from "@artfct-ai/contracts/types";

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

/**
 * Where a workflow stands in the store. It runs from the plan that created it. It is `ending` from
 * the start of its end until the end's last step, and `ended` after it. Both hold a workflow end.
 */
export type WorkflowLifecycle = "running" | "waiting_input" | "ending" | "ended";

/** The statuses a workflow end ends as. */
export type WorkflowEndStatus = Extract<WorkflowStatus, "done" | "failed" | "cancelled">;

/**
 * A workflow end. `reason` is the result of a done workflow, or why it failed or was cancelled.
 * `answering` is where the people who asked for the end wait. Empty for an end the agent asked for.
 * `posted` is true once the channels heard the end, so a resumed end does not post again.
 */
export type WorkflowEnd = {
  ends_as: WorkflowEndStatus;
  reason: string;
  answering: ReplyTarget[];
  posted: boolean;
};

/**
 * The status every reader outside the store sees. An ending or ended workflow shows the status its
 * end ends as, from the start of the end.
 */
export function workflowStatusOf(
  lifecycle: WorkflowLifecycle,
  end: WorkflowEnd | null,
): WorkflowStatus {
  if (lifecycle !== "ending" && lifecycle !== "ended") return lifecycle;
  if (!end) throw new Error(`the workflow is ${lifecycle} without its end`);
  return end.ends_as;
}

/** What a plan with stages set: the stages, the job slots, the page parent, and the root page. */
export type StagePlan = {
  stages: string[];
  job_slots: number;
  page_parent: string | null;
  root_page: RootPage | null;
};

/** The job slots of a workflow whose plan did not set stages yet. */
export const UNPLANNED_JOB_SLOTS = 2;

/** The job slots of the workflow: those the stage plan set, else `UNPLANNED_JOB_SLOTS`. */
export function jobSlotsOf(plan: StagePlan | null): number {
  return plan?.job_slots ?? UNPLANNED_JOB_SLOTS;
}

/** Workflow statuses a workflow never leaves. */
export const FINISHED_WORKFLOW_STATUSES: WorkflowStatus[] = ["done", "cancelled", "failed"];

/**
 * True when the workflow shows a finished status, from the start of its end. It stays finished:
 * every later event gets the finished reply or is dropped.
 */
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
