import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import type { JobRow, TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/** A tracker session as a reply target. */
export type TrackerSession = Extract<ReplyTarget, { source: "tracker" }>;

/** The statuses of an author that runs. An author in review is idle and does not run. */
const RUNNING_AUTHOR_STATUSES: TaskStatus[] = ["queued", "provisioning", "working"];

/** The tracker session on the job's issue, else the workflow's starting session. Null without either. */
export function jobSessionOf(workflow: WorkflowRuntime, job: JobRow): TrackerSession | null {
  const sessions = workflow.state.reply_targets.filter(
    (target): target is TrackerSession => target.source === "tracker",
  );
  const onIssue = job.issue_id
    ? sessions.find((session) => session.issue_id === job.issue_id)
    : undefined;
  if (onIssue) return onIssue;
  const { origin } = workflow.state;
  return origin?.source === "tracker" ? origin : null;
}

/**
 * The author that runs in the job whose job session this is. Null when no author runs there, and
 * when the session is the job session of more than one job whose author runs.
 */
export function runningAuthorInSession(
  workflow: WorkflowRuntime,
  session: TrackerSession,
): TaskRow | null {
  const running = workflow.store
    .jobs()
    .filter((job) => jobSessionOf(workflow, job)?.session_id === session.session_id)
    .flatMap((job) => {
      const author = workflow.store.authorTask(job.job_id);
      return author && RUNNING_AUTHOR_STATUSES.includes(author.status) ? [author] : [];
    });
  return running.length === 1 ? running[0]! : null;
}
