import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import { isTaskFinished } from "../store/state";
import type { JobRow, TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/** A tracker session as a reply target. */
export type TrackerSession = Extract<ReplyTarget, { source: "tracker" }>;

/** The statuses of an author that runs. An author in review is idle and does not run. */
const RUNNING_AUTHOR_STATUSES: TaskStatus[] = ["queued", "provisioning", "working"];

/** The tracker session on the job's input issue, if the job has one. */
export function jobSessionOf(workflow: WorkflowRuntime, job: JobRow): TrackerSession | null {
  if (!job.issue_id) return null;
  return (
    workflow.state.reply_targets.find(
      (target): target is TrackerSession =>
        target.source === "tracker" && target.issue_id === job.issue_id,
    ) ?? null
  );
}

/** The author that a message or a stop in this job session is for. */
export function authorInSession(
  workflow: WorkflowRuntime,
  session: TrackerSession,
): TaskRow | null {
  const authors = workflow.store
    .jobs()
    .filter((job) => jobSessionOf(workflow, job)?.session_id === session.session_id)
    .flatMap((job) => workflow.store.authorTask(job.job_id) ?? []);
  return authors.find((author) => !isTaskFinished(author.status)) ?? authors.at(-1) ?? null;
}

/** The author of this job session, only while it runs. */
export function runningAuthorInSession(
  workflow: WorkflowRuntime,
  session: TrackerSession,
): TaskRow | null {
  const author = authorInSession(workflow, session);
  return author && RUNNING_AUTHOR_STATUSES.includes(author.status) ? author : null;
}
