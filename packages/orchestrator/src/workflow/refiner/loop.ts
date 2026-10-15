import { noteMessage } from "../../agent/transcript/envelope";
import type { Review, ReviewSupport } from "../../artifact/types";
import type { JudgeEntry, ReviewerEntry } from "../../config/refiner";
import { resolveRefinerSettings } from "../../config/stage";
import { conclusionOf } from "../../prompts/review-prompt";
import { newToken, taskId as makeTaskId } from "../../ids";
import { stageHasRefiners } from "../artifact";
import { markBoardDirty } from "../board/board";
import { isTaskFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import { taskAtWork } from "../task/at-work";
import { clearTaskTimers, closeContainer, destroySandbox } from "../task/sandbox/sandbox";
import { taskSettings } from "../task/settings";
import type { WorkflowRuntime } from "../types";
import { checksGate } from "./checks-gate";
import { markArtifactReady, sendRejectionToAuthor, sendReviewToAuthor } from "./outcome";
import {
  endsSegment,
  judgeRejected,
  refinerIndexOf,
  refinerRunOf,
  refinerAt,
  reviewerEntryOf,
  reviewerSignature,
  firstEntryToRerun,
  firstUnreviewedEntry,
  segmentEndOf,
  segmentReviews,
  segmentStartOf,
  type FiledReview,
} from "./stage-refiner";
import { authorAskedForReview } from "./review-again";
import { reviewLimitReached } from "./review-limit";
import { askPersonToRule, ruleOnConclusion } from "./ruling";

/** Why the author's bridge sockets close when a polisher takes its artifact. */
const POLISH_CLOSE_REASON = "a polisher has the artifact";

/**
 * Settle the refiners over the artifact of an author's job once the author is quiet and the checks
 * of its revision passed. The open refiner run decides what happens. With no open refiner run, the
 * list runs from the top. A judge rules once on an artifact, so the author's answer to a rejection
 * goes on to the next entry. So does its answer to a review that reached the review limit.
 */
export async function settleRefinersForAuthor(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<void> {
  const artifact = workflow.store.artifact(task.job_id);
  if (!artifact || task.role !== "author") return;
  if (!stageHasRefiners(workflow.stageForTask(task))) return;
  if (artifact.status !== "drafted") return;
  if (isTaskFinished(task.status)) {
    return markArtifactReady(workflow, task.job_id, {
      close: "blocked",
      reason: `The agent review stopped: ${task.task_id} is ${task.status}.`,
    });
  }
  if (refinerInFlight(workflow, task.job_id) || !taskQuiet(workflow, task)) return;
  const gate = await checksGate(workflow, task, artifact);
  if (gate.gate === "blocked") {
    return markArtifactReady(workflow, task.job_id, { close: "blocked", reason: gate.reason });
  }
  if (gate.gate !== "open") return;
  // A prompt or another settle can land while the host is read.
  const author = workflow.store.requireTask(task.task_id);
  if (refinerInFlight(workflow, task.job_id) || !taskQuiet(workflow, author)) return;
  const pointer = refinerRunOf(workflow, artifact);
  if (!pointer) return rerunRefiners(workflow, task, artifact);
  if (pointer.role === "polisher") {
    workflow.store.setArtifactRefinerRun(task.job_id, null);
    workflow.log(
      task.task_id,
      "a finished polisher still holds the artifact. the refiners re-run.",
    );
    return rerunRefiners(workflow, task, artifact);
  }
  if (reviewerEntryOf(workflow, pointer)?.mode !== "judge") {
    if (reviewLimitReached(workflow, pointer)) {
      workflow.log(task.task_id, "the review limit is reached. no reviewer reads this revision.");
      await advanceArtifactPastEntry(workflow, author, refinerIndexOf(pointer));
      return;
    }
    if (taskSettings(workflow, task).execution === "model") {
      return routeByClosingText(workflow, task, artifact, pointer);
    }
    return askAgentToRoute(workflow, task, artifact, pointer);
  }
  if (judgeRejected(pointer)) await runRefinersFrom(workflow, task, refinerIndexOf(pointer) + 1);
}

/**
 * Run the list again from its first entry that did not review the artifact's revision. The
 * author row is read again after the host, because a prompt can reach the author meanwhile.
 */
async function rerunRefiners(
  workflow: WorkflowRuntime,
  author: TaskRow,
  artifact: ArtifactRow,
): Promise<void> {
  const revision = await artifactRevision(workflow, artifact);
  const current = workflow.store.requireTask(author.task_id);
  if (refinerInFlight(workflow, author.job_id) || !taskQuiet(workflow, current)) return;
  const from = firstEntryToRerun({
    entries: workflow.stageForTask(author).reviewers,
    runs: workflow.store.refinerRunsOf(author.job_id),
    revision,
  });
  if (from > 0)
    workflow.log(author.task_id, `entries before ${from} passed over: they reviewed this revision`);
  await runRefinersFrom(workflow, current, from);
}

/**
 * Run the first entry at or after `index` that still has a say. A judge entry that ruled on
 * this artifact is passed over, and the humans have the artifact once the list is exhausted.
 */
async function runRefinersFrom(
  workflow: WorkflowRuntime,
  author: TaskRow,
  index: number,
): Promise<string> {
  const stage = workflow.stageForTask(author);
  let nextIndex = index;
  while (judgeRuledOn(workflow, author, nextIndex)) {
    workflow.log(author.task_id, `entry ${nextIndex} passed over: its judge already ruled`);
    nextIndex += 1;
  }
  const next = refinerAt(stage, nextIndex);
  if (!next) {
    await markArtifactReady(workflow, author.job_id, { close: "ready" });
    return `The humans have the artifact of job ${author.job_id}.`;
  }
  await startRefiner(workflow, author, nextIndex);
  return `The next entry ${next.entry.name} started on job ${author.job_id}.`;
}

/** True when the entry at `index` is a judge entry whose ruling this artifact already has. */
function judgeRuledOn(workflow: WorkflowRuntime, author: TaskRow, index: number): boolean {
  if (workflow.stageForTask(author).reviewers[index]?.mode !== "judge") return false;
  return workflow.store
    .refinerRunsOf(author.job_id)
    .some(
      (run) =>
        refinerIndexOf(run) === index && run.role === "reviewer" && run.result?.kind === "ruling",
    );
}

/** True while the review still holds this artifact back from the humans. */
export function heldForReview(workflow: WorkflowRuntime, artifact: ArtifactRow): boolean {
  const job = workflow.store.requireJob(artifact.job_id);
  return stageHasRefiners(workflow.stageFor(job)) && artifact.status === "drafted";
}

/**
 * True while the task takes no prompts, so its artifact stands still. A task that has not
 * started, or whose harness session is still opening, sends its first prompt on its own.
 */
export function taskQuiet(workflow: WorkflowRuntime, task: TaskRow): boolean {
  if (taskAtWork(workflow, task)) return false;
  return !workflow.store.queue().some((row) => row.task_id === task.task_id);
}

/** True while the refiner run on the job's artifact has not finished. A failed refiner run is over. */
export function refinerInFlight(workflow: WorkflowRuntime, jobId: string): boolean {
  const artifact = workflow.store.artifact(jobId);
  const run = artifact ? refinerRunOf(workflow, artifact) : null;
  return run !== null && !isTaskFinished(run.status);
}

/**
 * Route the artifact of a model-call author by the review again decision over its closing text.
 * Yes re-runs the open segment. No hands the artifact on. With no decision, the agent routes.
 */
async function routeByClosingText(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow,
  pointer: TaskRow,
): Promise<void> {
  const reviewAgain = await authorAskedForReview(workflow, task);
  if (reviewAgain === null) return askAgentToRoute(workflow, task, artifact, pointer);
  const revision = await artifactRevision(workflow, artifact);
  const author = workflow.store.requireTask(task.task_id);
  if (refinerInFlight(workflow, task.job_id) || !taskQuiet(workflow, author)) return;
  const index = refinerIndexOf(pointer);
  const entries = workflow.stageForTask(author).reviewers;
  const runs = workflow.store.refinerRunsOf(author.job_id);
  const from = segmentStartOf(index, entries);
  const rerun = reviewAgain ? firstUnreviewedEntry({ entries, runs, from, revision }) : null;
  if (rerun === null) {
    if (reviewAgain)
      workflow.log(task.task_id, "review again passed over: the revision is reviewed");
    await advanceArtifactPastEntry(workflow, author, index);
    return;
  }
  await startRefiner(workflow, author, rerun);
}

/** Hand the artifact to the agent, which decides between another refiner run and the humans. */
async function askAgentToRoute(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow,
  pointer: TaskRow,
): Promise<void> {
  const entries = workflow.stageForTask(task).reviewers;
  const index = refinerIndexOf(pointer);
  const open = entries
    .slice(segmentStartOf(index, entries), index + 1)
    .map((entry) => entry.name)
    .join(", ");
  workflow.log(task.task_id, "the agent review of this artifact is with you");
  await markBoardDirty(workflow, task.job_id);
  await workflow.tellAgent(
    noteMessage(
      [
        `The agent review of ${artifact.external_url} in job ${task.job_id} is with you. Its author ${task.task_id} is idle after a reviewer run.`,
        `The open segment is the entries ${open}.`,
        "Read what it said with read_task, and the artifact itself when that is not enough.",
        "Then route it: request_review re-runs the open segment on a revision it did not review, finish_review ends it and hands on. It waits until you call one of them.",
        "The humans hear the artifact when it is ready, so end the turn silent unless a person must decide something.",
      ].join(" "),
    ),
    "task_result",
  );
}

/**
 * Start the refiner run at one index, with its own sandbox, on the author's branch and
 * artifact. A polisher changes that artifact in place, so the author's container closes
 * before it starts and the two never work the branch at once.
 */
export async function startRefiner(
  workflow: WorkflowRuntime,
  author: TaskRow,
  index: number,
): Promise<void> {
  const refiner = refinerAt(workflow.stageForTask(author), index);
  if (!refiner) {
    const { stage } = workflow.store.requireJob(author.job_id);
    workflow.log(
      author.task_id,
      `the refiners stop: stage ${stage} declares no refiner entry ${index}`,
    );
    await markArtifactReady(workflow, author.job_id, {
      close: "blocked",
      reason: `Stage ${stage} no longer declares refiner entry ${index}.`,
    });
    return;
  }
  const settings = resolveRefinerSettings(workflow.config(), refiner.entry);
  const sequence = workflow.state.task_seq + 1;
  const refinerRunId = makeTaskId(workflow.state.workflow_id, sequence);
  workflow.store.insertTask({
    task_id: refinerRunId,
    job_id: author.job_id,
    role: refiner.role,
    refiner_index: index,
    sandbox: { harness: settings.harness, bridge_token: newToken() },
    model: settings.model,
  });
  workflow.patchState({ task_seq: sequence });
  workflow.store.setArtifactRefinerRun(author.job_id, refinerRunId);
  if (refiner.role === "polisher" && workflow.store.sandbox(author.task_id)) {
    await closeContainer(workflow, workflow.store.requireTask(author.task_id), POLISH_CLOSE_REASON);
  }
  const word = refiner.role === "polisher" ? "polish" : "review";
  workflow.log(author.task_id, `${word} as ${refinerRunId}: entry ${index} ${refiner.entry.name}`);
  await markBoardDirty(workflow, author.job_id);
  await workflow.scheduleAlarm(0, "provision", { task_id: refinerRunId });
}

/**
 * A reviewer run finished its turn with `turnText`. Code rules on a judge entry. A findings
 * entry hands its review to the next entry, or settles its segment when it is the last one.
 */
export async function onReviewerFinished(
  workflow: WorkflowRuntime,
  refinerRun: TaskRow,
  turnText: string,
): Promise<void> {
  const reviewer = workflow.store.requireTask(refinerRun.task_id);
  if (isTaskFinished(reviewer.status)) return;
  const entry = reviewerEntryOf(workflow, reviewer);
  const review =
    !entry || entry.mode === "judge" ? null : await readReview(workflow, reviewer, entry, turnText);
  await finishRefinerRun(workflow, reviewer);
  if (review) workflow.store.updateTask(reviewer.task_id, { result: review });
  const author = workflow.store.authorTaskOf(reviewer.job_id);
  const artifact = workflow.store.artifact(reviewer.job_id);
  if (!artifact) return;
  if (artifact.refiner_task_id !== reviewer.task_id) {
    workflow.log(
      author.task_id,
      "reviewer run dropped: the artifact no longer holds this reviewer",
    );
    return;
  }
  if (artifact.status !== "drafted") {
    workflow.log(
      author.task_id,
      `reviewer run dropped: the artifact is already ${artifact.status}`,
    );
    return;
  }
  if (entry?.mode === "judge") return settleJudgeEntry(workflow, author, reviewer, entry);
  const entries = workflow.stageForTask(author).reviewers;
  const index = refinerIndexOf(reviewer);
  const revision = await artifactRevision(workflow, artifact);
  const runs = workflow.store.refinerRunsOf(author.job_id);
  const next = endsSegment(index, entries)
    ? null
    : firstUnreviewedEntry({ entries, runs, from: index + 1, revision });
  if (next !== null) {
    await advanceArtifactPastEntry(workflow, author, next - 1);
    return;
  }
  const end = segmentEndOf(index, entries);
  if (end !== index) {
    const endRun = runs.findLast((run) => run.refiner_index === end);
    if (endRun) workflow.store.setArtifactRefinerRun(author.job_id, endRun.task_id);
  }
  const settled = segmentReview(workflow, author, end, revision);
  if (settled.stale) {
    workflow.log(author.task_id, "reviewer run dropped: the artifact moved while the reviewer ran");
    const current = workflow.store.requireTask(author.task_id);
    const start = segmentStartOf(end, entries);
    const rerun = firstUnreviewedEntry({ entries, runs, from: start, revision }) ?? start;
    return taskQuiet(workflow, current)
      ? startRefiner(workflow, author, rerun)
      : settleRefinersForAuthor(workflow, current);
  }
  if (settled.review && (settled.review.blocking || settled.review.findings.length)) {
    return sendReviewToAuthor(workflow, author, artifact, settled.review);
  }
  await advanceArtifactPastEntry(workflow, author, end);
}

/** Rule on what a judge reviewer concluded, or ask a person when code cannot tell. */
async function settleJudgeEntry(
  workflow: WorkflowRuntime,
  author: TaskRow,
  reviewer: TaskRow,
  entry: JudgeEntry,
): Promise<void> {
  const conclusion = conclusionOf(reviewer.summary);
  const ruling = await ruleOnConclusion(workflow, reviewer, entry, conclusion);
  if (ruling === "approved") {
    await applyJudgeRuling(workflow, { author, reviewer, ruling });
    return;
  }
  if (ruling === "rejected") {
    await applyJudgeRuling(workflow, { author, reviewer, ruling, reason: conclusion });
    return;
  }
  const ruledMeanwhile = validateJudgeAwaitsRuling(workflow, reviewer);
  if (ruledMeanwhile) {
    workflow.log(author.task_id, `the agent does not ask a person to rule: ${ruledMeanwhile}`);
    return;
  }
  const artifact = workflow.store.artifact(author.job_id);
  if (artifact) await askPersonToRule(workflow, { author, artifact, entry, conclusion });
}

type JudgeRuling = { ruling: "approved" } | { ruling: "rejected"; reason: string };

/**
 * Why a ruling on this judge run must not be applied now: the run already has a ruling, or the
 * artifact moved on from it. Null while the artifact still waits for the run's ruling.
 */
function validateJudgeAwaitsRuling(workflow: WorkflowRuntime, reviewer: TaskRow): string | null {
  const run = workflow.store.requireTask(reviewer.task_id);
  if (run.result?.kind === "ruling") {
    return `The judge ${run.task_id} of job ${run.job_id} already ruled ${run.result.ruling}.`;
  }
  const artifact = workflow.store.artifact(run.job_id);
  if (!artifact || artifact.status !== "drafted") {
    return `The agent review of job ${run.job_id} is over.`;
  }
  if (artifact.refiner_task_id !== run.task_id) {
    return `The artifact of job ${run.job_id} moved on from the judge ${run.task_id}.`;
  }
  return null;
}

/** Act on the ruling of a judge entry. The decisions model or a person made it. */
export async function applyJudgeRuling(
  workflow: WorkflowRuntime,
  input: { author: TaskRow; reviewer: TaskRow } & JudgeRuling,
): Promise<string> {
  const { author, reviewer } = input;
  const artifact = workflow.store.artifact(author.job_id);
  const entry = reviewerEntryOf(workflow, reviewer);
  const support = artifact ? reviewSupportOf(workflow, artifact) : null;
  if (!artifact || !entry || !support)
    return `The artifact or the reviewer entry of job ${author.job_id} is gone.`;
  const revision = await support.revision(artifact.ref);
  const refusal = validateJudgeAwaitsRuling(workflow, reviewer);
  if (refusal) {
    workflow.log(author.task_id, `${entry.name} ${input.ruling} dropped: ${refusal}`);
    return refusal;
  }
  workflow.log(author.task_id, `${entry.name} ${input.ruling} on ${reviewer.task_id}`);
  if (input.ruling === "approved") {
    workflow.store.updateTask(reviewer.task_id, {
      result: { kind: "ruling", revision, ruling: "approved" },
    });
    return advanceArtifactPastEntry(workflow, author, refinerIndexOf(reviewer));
  }
  workflow.store.updateTask(reviewer.task_id, {
    result: { kind: "ruling", revision, ruling: "rejected", reason: input.reason },
  });
  const { reason } = input;
  const signedReason = `${reason}\n\n${reviewerSignature(workflow, entry, reviewer)}`;
  if (support.postRejection) await support.postRejection(artifact.ref, signedReason);
  else await workflow.post({ type: "info", text: signedReason });
  await sendRejectionToAuthor(workflow, author, artifact, { entry: entry.name, reason });
  return `The author ${author.task_id} has the rejection. The ${entry.name} judge has ruled, so the next entry runs when its turn ends.`;
}

/**
 * What follows the entry at `index`: the next refiner of the stage runs, and the humans have
 * the artifact once the list is exhausted. The author row is read again here, because a
 * prompt can reach the author while the segment's review was being settled. A working author
 * stops the refiners, and the list re-runs from the top once its turn ends.
 */
export async function advanceArtifactPastEntry(
  workflow: WorkflowRuntime,
  author: TaskRow,
  index: number,
): Promise<string> {
  const current = workflow.store.requireTask(author.task_id);
  if (!taskQuiet(workflow, current)) {
    workflow.store.setArtifactRefinerRun(author.job_id, null);
    return `${author.task_id} is still working. The refiners stop and re-run once its turn ends.`;
  }
  return runRefinersFrom(workflow, author, index + 1);
}

/**
 * The merged review of the segment that ends at `index`, and whether the artifact moved from
 * `revision` under any review of it.
 */
function segmentReview(
  workflow: WorkflowRuntime,
  author: TaskRow,
  index: number,
  revision: string | null,
): { review: Review | null; stale: boolean } {
  const entries = workflow.stageForTask(author).reviewers;
  const filed = segmentReviews(
    workflow.store.refinerRunsOf(author.job_id),
    segmentStartOf(index, entries),
    index,
  );
  const review = mergeReviews(entries, filed);
  if (!review) return { review: null, stale: false };
  const stale = revision !== null && filed.some((entry) => entry.review.revision !== revision);
  return { review, stale };
}

/** The revision the host gives the artifact now. Null when its kind has no reviewer or the host cannot say. */
export async function artifactRevision(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow,
): Promise<string | null> {
  const support = reviewSupportOf(workflow, artifact);
  return support ? support.revision(artifact.ref) : null;
}

/**
 * The segment's review: findings in list order, summaries joined under entry names, and
 * blocking when any of them is. Null when no entry of the segment filed one.
 */
function mergeReviews(entries: ReviewerEntry[], reviews: FiledReview[]): Review | null {
  const filed = reviews
    .toSorted((left, right) => left.refiner_index - right.refiner_index)
    .map((entry) => ({ name: entries[entry.refiner_index]?.name ?? "", review: entry.review }));
  if (!filed.length) return null;
  return {
    kind: "review",
    revision: filed.at(-1)!.review.revision,
    blocking: filed.some((entry) => entry.review.blocking),
    summary: filed
      .filter((entry) => entry.review.summary.trim())
      .map((entry) => `${entry.name}: ${entry.review.summary.trim()}`)
      .join("\n\n"),
    findings: filed.flatMap((entry) => entry.review.findings),
  };
}

/** What the reviewer filed since it started, or null when it filed nothing. */
async function readReview(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  entry: ReviewerEntry,
  turnText: string,
): Promise<Review | null> {
  const artifact = workflow.store.artifact(reviewer.job_id);
  const support = artifact ? reviewSupportOf(workflow, artifact) : null;
  if (!artifact || !support) return null;
  return support.postedReview(artifact.ref, {
    since: reviewer.started_at,
    turnText,
    signature: reviewerSignature(workflow, entry, reviewer),
  });
}

/** How this artifact's kind is reviewed. Null for a kind with no reviewer. */
function reviewSupportOf(workflow: WorkflowRuntime, artifact: ArtifactRow): ReviewSupport | null {
  return workflow.artifact(artifact.kind).review ?? null;
}

/** Stop a refiner run and destroy its sandbox. The run is over either way. */
export async function finishRefinerRun(workflow: WorkflowRuntime, run: TaskRow): Promise<void> {
  if (isTaskFinished(run.status)) return;
  workflow.store.updateTask(run.task_id, { status: "done" });
  await clearTaskTimers(workflow, workflow.store.requireSandbox(run.task_id));
  await destroySandbox(workflow, run);
}

/** The reviewer run died. The humans get the artifact, with the reason said. */
export async function onReviewerFailed(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  reason: string,
): Promise<void> {
  const author = workflow.store.authorTaskOf(reviewer.job_id);
  const artifact = workflow.store.artifact(reviewer.job_id);
  if (!artifact) return;
  if (artifact.refiner_task_id !== reviewer.task_id) {
    workflow.log(
      author.task_id,
      "reviewer run dropped: the artifact no longer holds this reviewer",
    );
    return;
  }
  workflow.store.setArtifactRefinerRun(author.job_id, null);
  if (artifact.status !== "drafted") {
    workflow.log(
      author.task_id,
      `reviewer run dropped: the artifact is already ${artifact.status}`,
    );
    return;
  }
  await markArtifactReady(workflow, author.job_id, {
    close: "blocked",
    reason: `The reviewer could not run (${reason}).`,
  });
}
