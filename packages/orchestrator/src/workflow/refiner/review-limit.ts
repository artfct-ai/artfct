import type { WorkflowRuntime } from "../types";
import type { TaskRow } from "../store/tasks";
import { refinerIndexOf, runNumberOf, segmentReviews, segmentStartOf } from "./stage-refiner";

/**
 * True when the entry of a reviewer run has run on its artifact as often as `max_review_runs`
 * allows. The author's answer to its review then goes on without another review.
 */
export function reviewLimitReached(workflow: WorkflowRuntime, run: TaskRow): boolean {
  return runNumberOf(workflow, run) >= workflow.config().orchestrator.max_review_runs;
}

/**
 * What the handover adds when the review limit ended the agent review: the author answered the
 * latest findings and no reviewer read that revision. Null when a reviewer had the last word.
 */
export function unreviewedRevisionNote(workflow: WorkflowRuntime, jobId: string): string | null {
  const runs = workflow.store.refinerRunsOf(jobId).filter((run) => run.role === "reviewer");
  const last = runs.at(-1);
  if (!last || !reviewLimitReached(workflow, last)) return null;
  const index = refinerIndexOf(last);
  const start = segmentStartOf(index, workflow.stageForTask(last).reviewers);
  const leftFindings = segmentReviews(runs, start, index).some(
    ({ review }) => review.blocking || review.findings.length > 0,
  );
  if (!leftFindings) return null;
  const limit = workflow.config().orchestrator.max_review_runs;
  return `The author answered the latest review findings. The agent review reached its limit of ${limit} run${limit === 1 ? "" : "s"}, so that revision did not get a review.`;
}
