import type { Review } from "../../artifact/types";
import type { RefinerEntry, ReviewerEntry } from "../../config/refiner";
import type { Stage } from "../../config/stage";
import { isTaskFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/**
 * One position in a stage's refiner list. The reviewers run first and settle between them, then
 * the polishers change the artifact in place. The `refiner_index` of a refiner run is its position.
 */
export type StageRefiner =
  | { role: "reviewer"; entry: ReviewerEntry }
  | { role: "polisher"; entry: RefinerEntry };

/** What the stage runs at one index, or null once its list is exhausted. */
export function refinerAt(
  stage: Pick<Stage, "reviewers" | "polishers">,
  index: number,
): StageRefiner | null {
  const reviewer = stage.reviewers[index];
  if (reviewer) return { role: "reviewer", entry: reviewer };
  const polisher = stage.polishers[index - stage.reviewers.length];
  return polisher ? { role: "polisher", entry: polisher } : null;
}

/** How many refiners the stage runs over its artifact before the humans see it. */
export function refinerCount(stage: Pick<Stage, "reviewers" | "polishers">): number {
  return stage.reviewers.length + stage.polishers.length;
}

/**
 * The index of the entry that opens the segment `index` sits in. A segment runs from the
 * first entry after the previous one that ends a segment, or from the first entry.
 */
export function segmentStartOf(index: number, entries: ReviewerEntry[]): number {
  let start = index;
  while (start > 0 && !endsSegment(start - 1, entries)) start -= 1;
  return start;
}

/** True when the entry at `index` ends its segment: it is a judge entry or the last entry. */
export function endsSegment(index: number, entries: ReviewerEntry[]): boolean {
  return entries[index]?.mode === "judge" || index === entries.length - 1;
}

/** A review filed by one entry of a segment, with the entry's position. */
export type FiledReview = { refiner_index: number; review: Review };

/** The reviews filed in the segment that ends at `index`, from its latest run only. */
export function segmentReviews(runs: TaskRow[], start: number, index: number): FiledReview[] {
  const latestRunStart = runs.filter((run) => run.refiner_index === start).at(-1)?.started_at ?? "";
  return runs.flatMap((run) =>
    run.refiner_index !== null &&
    run.refiner_index >= start &&
    run.refiner_index <= index &&
    run.started_at >= latestRunStart &&
    run.result?.kind === "review"
      ? [{ refiner_index: run.refiner_index, review: run.result }]
      : [],
  );
}

/** The reviewer entry of a refiner run, or null when its stage no longer declares it. */
export function reviewerEntryOf(workflow: WorkflowRuntime, run: TaskRow): ReviewerEntry | null {
  const refiner = refinerAt(workflow.stageForTask(run), refinerIndexOf(run));
  return refiner?.role === "reviewer" ? refiner.entry : null;
}

/** The entry index a refiner run ran. An author task reads as entry 0. */
export function refinerIndexOf(task: TaskRow): number {
  return task.refiner_index ?? 0;
}

/** True when a judge filed a rejection on this refiner run. */
export function judgeRejected(run: TaskRow): boolean {
  return run.result?.kind === "ruling" && run.result.ruling === "rejected";
}

/** The refiner run the artifact points at, or null once the pointer is cleared. */
export function refinerRunOf(workflow: WorkflowRuntime, artifact: ArtifactRow): TaskRow | null {
  return artifact.refiner_task_id ? workflow.store.task(artifact.refiner_task_id) : null;
}

/**
 * The polisher changing the artifact of this job right now, or null when none is. The author
 * has no container and takes no prompt while one runs.
 */
export function runningPolisherOf(workflow: WorkflowRuntime, jobId: string): TaskRow | null {
  const artifact = workflow.store.artifact(jobId);
  const run = artifact ? refinerRunOf(workflow, artifact) : null;
  if (!run || run.role !== "polisher" || isTaskFinished(run.status)) return null;
  return run;
}

/** Which run of its entry a refiner run is, counted from 1 over the runs on the same artifact. */
export function runNumberOf(workflow: WorkflowRuntime, run: TaskRow): number {
  return workflow.store
    .refinerRunsOf(run.job_id)
    .filter(
      (earlier) =>
        refinerIndexOf(earlier) === refinerIndexOf(run) && earlier.started_at <= run.started_at,
    ).length;
}

/** The line that tells a reader which reviewer entry, run, and task a review came from. */
export function reviewerSignature(
  workflow: WorkflowRuntime,
  entry: ReviewerEntry,
  run: TaskRow,
): string {
  return `Reviewer: ${entry.name} · run ${runNumberOf(workflow, run)} · task ${run.task_id}`;
}
