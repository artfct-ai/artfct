import { noteMessage } from "../../agent/transcript/envelope";
import type { Review, ReviewRead, ReviewSupport } from "../../artifact/types";
import type { JudgeEntry, ReviewerEntry } from "../../config/refiner";
import { resolveRefinerSettings } from "../../config/stage";
import { conclusionOf } from "../../prompts/review-prompt";
import { newToken, taskId as makeTaskId } from "../../ids";
import { stageHasRefiners } from "../artifact";
import { markBoardDirty } from "../board/board";
import { isTaskFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import { taskAtWork } from "../task/at-work";
import { finishTask } from "../lifecycle";
import { closeContainer } from "../task/sandbox/sandbox";
import { taskSettings } from "../task/settings";
import type { TaskAlarm } from "../task/harness/timers";
import type { WorkflowRuntime } from "../types";
import { checksGate } from "./checks-gate";
import {
  artifactRevision,
  handOverArtifactAt,
  markArtifactReady,
  revisionOfTheJobsArtifact,
  sendRejectionToAuthor,
  sendReviewToAuthor,
} from "./outcome";
import {
  judgeRuled,
  refinerIndexOf,
  refinerRunOf,
  refinerAt,
  reviewerEntryOf,
  reviewerSignature,
  nextEntryToRun,
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
  if (!pointer) return runRefinersOnRevision(workflow, author, artifact, 0);
  if (pointer.role === "polisher") {
    workflow.store.setArtifactRefinerRun(task.job_id, null);
    workflow.log(
      task.task_id,
      "a finished polisher still holds the artifact. the refiners re-run.",
    );
    return runRefinersOnRevision(workflow, author, artifact, 0);
  }
  if (reviewerEntryOf(workflow, pointer)?.mode !== "judge") {
    if (reviewLimitReached(workflow, pointer)) {
      workflow.log(task.task_id, "the review limit is reached. no reviewer reads this revision.");
      return runRefinersOnRevision(workflow, author, artifact, refinerIndexOf(pointer) + 1);
    }
    if (taskSettings(workflow, task).execution === "model") {
      return routeByClosingText(workflow, task, artifact, pointer);
    }
    return askAgentToRoute(workflow, task, artifact, pointer);
  }
  if (workflow.store.ruling(pointer.task_id)?.status === "rejected") {
    await runRefinersOnRevision(workflow, author, artifact, refinerIndexOf(pointer) + 1);
  }
}

/**
 * Run the list from `from` on the revision the host gives the artifact now. The author row is
 * read again after the host, because a prompt can reach the author meanwhile.
 */
async function runRefinersOnRevision(
  workflow: WorkflowRuntime,
  author: TaskRow,
  artifact: ArtifactRow,
  from: number,
): Promise<void> {
  const revision = await artifactRevision(workflow, artifact);
  const current = workflow.store.requireTask(author.task_id);
  if (refinerInFlight(workflow, author.job_id) || !taskQuiet(workflow, current)) return;
  await runRefinersFrom(workflow, current, from, revision);
}

/**
 * Run the next entry from `index` on that still has to read `revision`, and give the humans
 * the artifact once the list is exhausted. Every path that starts a refiner of the list goes
 * through here.
 */
export async function runRefinersFrom(
  workflow: WorkflowRuntime,
  author: TaskRow,
  index: number,
  revision: string | null,
): Promise<string> {
  const stage = workflow.stageForTask(author);
  const runs = workflow.store.refinerRunsOf(author.job_id);
  const nextIndex = nextEntryToRun({ entries: stage.reviewers, runs, from: index, revision });
  if (nextIndex > index) {
    workflow.log(
      author.task_id,
      `entries ${index} to ${nextIndex - 1} passed over: they had their say on this revision`,
    );
  }
  const next = refinerAt(stage, nextIndex);
  if (!next) {
    await handOverArtifactAt(workflow, author.job_id, { close: { close: "ready" }, revision });
    return `The humans have the artifact of job ${author.job_id}.`;
  }
  await startRefiner(workflow, author, nextIndex);
  return `The next entry ${next.entry.name} started on job ${author.job_id}.`;
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
  const unreviewed =
    nextEntryToRun({ entries, runs, from, revision }) <= segmentEndOf(index, entries);
  if (reviewAgain && unreviewed) {
    await runRefinersFrom(workflow, author, from, revision);
    return;
  }
  if (reviewAgain) workflow.log(task.task_id, "review again passed over: the revision is reviewed");
  await advanceArtifactPastEntry(workflow, author, index, revision);
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
 * A reviewer run finished its turn with `turnText`. It ends done once its review is routed, and
 * its sandbox goes last.
 */
export async function onReviewerFinished(
  workflow: WorkflowRuntime,
  refinerRun: TaskRow,
  turnText: string,
): Promise<void> {
  const reviewer = workflow.store.requireTask(refinerRun.task_id);
  if (isTaskFinished(reviewer.status)) return;
  const entry = reviewerEntryOf(workflow, reviewer);
  const read: ReviewRead =
    !entry || entry.mode === "judge"
      ? { filedNone: true }
      : await readReview(workflow, reviewer, entry, turnText);
  const revision =
    entry?.mode === "judge" ? null : await revisionOfTheJobsArtifact(workflow, reviewer.job_id);
  await finishTask(workflow, reviewer, () =>
    routeReview(workflow, reviewer, { entry, read, revision }),
  );
}

/**
 * Route the review of a reviewer run that ended done, on the revision read before it ended. Code
 * rules on a judge entry. A findings entry hands its review to the next entry, or settles its
 * segment when it is the last one. A review that cannot be read hands the artifact over blocked.
 */
async function routeReview(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  ended: { entry: ReviewerEntry | null; read: ReviewRead; revision: string | null },
): Promise<void> {
  const { entry, read, revision } = ended;
  if ("readFailed" in read)
    return handOverBlockedFromReviewer(workflow, reviewer, {
      reason: `The reviewer's review could not be read (${read.readFailed}).`,
      revision,
    });
  if ("review" in read) workflow.store.fileReview(reviewer.task_id, read.review);
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
  const runs = workflow.store.refinerRunsOf(author.job_id);
  const end = segmentEndOf(index, entries);
  const next = nextEntryToRun({ entries, runs, from: index + 1, revision });
  if (index !== end && next <= end) {
    await advanceArtifactPastEntry(workflow, author, index, revision);
    return;
  }
  pointAtLastReviewerOfSegment(workflow, author, end);
  const settled = segmentReview(workflow, author, end, revision);
  if (settled.stale) {
    workflow.log(author.task_id, "reviewer run dropped: the artifact moved while the reviewer ran");
    const current = workflow.store.requireTask(author.task_id);
    if (!taskQuiet(workflow, current)) return settleRefinersForAuthor(workflow, current);
    await runRefinersFrom(workflow, current, segmentStartOf(end, entries), revision);
    return;
  }
  if (reviewAsksTheAuthor(settled.review)) {
    return sendReviewToAuthor(workflow, author, artifact, settled.review);
  }
  await advanceArtifactPastEntry(workflow, author, end, revision);
}

/** True when a segment's review holds findings or blocks, so its author answers it. */
function reviewAsksTheAuthor(review: Review | null): review is Review {
  return review !== null && (review.blocking || review.findings.length > 0);
}

/**
 * Point the artifact at the latest run of the last findings entry of the segment that ends at
 * `end`, so the author's answer to the segment's review is routed from there. A judge that ends
 * the segment has ruled once, and the list passes over it.
 */
function pointAtLastReviewerOfSegment(
  workflow: WorkflowRuntime,
  author: TaskRow,
  end: number,
): void {
  const entries = workflow.stageForTask(author).reviewers;
  const lastReviewer = entries[end]?.mode === "judge" ? end - 1 : end;
  const run = workflow.store
    .refinerRunsOf(author.job_id)
    .findLast((candidate) => candidate.refiner_index === lastReviewer);
  if (run) workflow.store.setArtifactRefinerRun(author.job_id, run.task_id);
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
  if (artifact) await askPersonToRule(workflow, { author, reviewer, artifact, entry, conclusion });
}

/**
 * The judge runs whose ruling call a new instance lost: each done judge run the artifact waits on
 * that neither has a ruling nor asked a person for one.
 */
export function lostJudgeRulings(workflow: WorkflowRuntime): TaskAlarm[] {
  return workflow.store
    .tasks()
    .filter((run) => judgeEntryWithoutARulingAsked(workflow, run))
    .map((run) => ({ task_id: run.task_id }));
}

/** Alarm: rule on a done judge run whose ruling call a lost instance had out. */
export async function settleLostJudgeRuling(
  workflow: WorkflowRuntime,
  alarm: TaskAlarm,
): Promise<void> {
  const reviewer = workflow.store.task(alarm.task_id);
  const entry = reviewer && judgeEntryWithoutARulingAsked(workflow, reviewer);
  if (!reviewer || !entry) return;
  workflow.log(reviewer.task_id, "ruling asked again: a new instance lost the ruling call");
  await settleJudgeEntry(workflow, workflow.store.authorTaskOf(reviewer.job_id), reviewer, entry);
}

/**
 * The judge entry of a done judge run the artifact waits on, when neither a ruling nor the
 * agent's ask for a person's ruling is recorded. Null otherwise.
 */
function judgeEntryWithoutARulingAsked(workflow: WorkflowRuntime, run: TaskRow): JudgeEntry | null {
  if (run.role !== "reviewer" || run.status !== "done") return null;
  if (workflow.store.ruling(run.task_id)) return null;
  const entry = reviewerEntryOf(workflow, run);
  if (entry?.mode !== "judge") return null;
  return validateJudgeAwaitsRuling(workflow, run) ? null : entry;
}

type JudgeRuling = { ruling: "approved" } | { ruling: "rejected"; reason: string };

/**
 * Why a ruling on this judge run must not be applied now: the run already has a ruling, or the
 * artifact moved on from it. Null while the artifact still waits for the run's ruling.
 */
function validateJudgeAwaitsRuling(workflow: WorkflowRuntime, run: TaskRow): string | null {
  const ruling = workflow.store.ruling(run.task_id);
  if (judgeRuled(ruling)) {
    return `The judge ${run.task_id} of job ${run.job_id} already ruled ${ruling.status}.`;
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
  const index = refinerIndexOf(reviewer);
  const { review } = segmentReview(workflow, author, index, revision);
  if (input.ruling === "approved") {
    workflow.store.recordRuling(reviewer.task_id, { status: "approved", revision });
    if (!reviewAsksTheAuthor(review)) {
      return advanceArtifactPastEntry(workflow, author, index, revision);
    }
    pointAtLastReviewerOfSegment(workflow, author, index);
    await sendReviewToAuthor(workflow, author, artifact, review);
    return `The ${entry.name} judge approved. The author ${author.task_id} has the findings of the reviewers before it, and you route the artifact when its turn ends.`;
  }
  workflow.store.recordRuling(reviewer.task_id, {
    status: "rejected",
    revision,
    reason: input.reason,
  });
  const { reason } = input;
  const signedReason = `${reason}\n\n${reviewerSignature(workflow, entry, reviewer)}`;
  if (support.postRejection) await support.postRejection(artifact.ref, signedReason);
  else await workflow.post({ type: "info", text: signedReason });
  await sendRejectionToAuthor(workflow, author, artifact, {
    entry: entry.name,
    reason,
    review: reviewAsksTheAuthor(review) ? review : null,
  });
  return `The author ${author.task_id} has the rejection. The ${entry.name} judge has ruled, so the next entry runs when its turn ends.`;
}

/**
 * What follows the entry at `index` on `revision`: the list runs on from the next entry. The
 * author row is read again here, because a prompt can reach the author while the segment's
 * review was being settled. A working author stops the refiners, and the list re-runs once its
 * turn ends.
 */
export async function advanceArtifactPastEntry(
  workflow: WorkflowRuntime,
  author: TaskRow,
  index: number,
  revision: string | null,
): Promise<string> {
  const current = workflow.store.requireTask(author.task_id);
  if (!taskQuiet(workflow, current)) {
    workflow.store.setArtifactRefinerRun(author.job_id, null);
    return `${author.task_id} is still working. The refiners stop and re-run once its turn ends.`;
  }
  return runRefinersFrom(workflow, author, index + 1, revision);
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
    revision: filed.at(-1)!.review.revision,
    blocking: filed.some((entry) => entry.review.blocking),
    summary: filed
      .filter((entry) => entry.review.summary.trim())
      .map((entry) => `${entry.name}: ${entry.review.summary.trim()}`)
      .join("\n\n"),
    findings: filed.flatMap((entry) => entry.review.findings),
  };
}

/** What the reviewer filed since it started: its review, none, or a read that failed. */
async function readReview(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  entry: ReviewerEntry,
  turnText: string,
): Promise<ReviewRead> {
  const artifact = workflow.store.artifact(reviewer.job_id);
  const support = artifact ? reviewSupportOf(workflow, artifact) : null;
  if (!artifact || !support) return { filedNone: true };
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

/** The reviewer run died. The humans get the artifact, with the reason said. */
export async function onReviewerFailed(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  reason: string,
): Promise<void> {
  await handOverBlockedFromReviewer(workflow, reviewer, {
    reason: `The reviewer could not run (${reason}).`,
    revision: await revisionOfTheJobsArtifact(workflow, reviewer.job_id),
  });
}

/**
 * Hand the drafted artifact the reviewer holds over blocked at `revision`, with `reason` in place
 * of the ready line.
 */
async function handOverBlockedFromReviewer(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  blocked: { reason: string; revision: string | null },
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
  await handOverArtifactAt(workflow, author.job_id, {
    close: { close: "blocked", reason: blocked.reason },
    revision: blocked.revision,
  });
}
