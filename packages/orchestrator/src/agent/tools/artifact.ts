import { tool } from "ai";
import { z } from "zod";
import {
  advanceArtifactPastEntry,
  applyJudgeRuling,
  taskQuiet,
  heldForReview,
  refinerInFlight,
  startRefiner,
} from "../../workflow/refiner/loop";
import { polisherRefusal } from "../../workflow/refiner/polish";
import { reviewLimitReached } from "../../workflow/refiner/review-limit";
import {
  judgeRejected,
  refinerIndexOf,
  refinerRunOf,
  refinerAt,
  reviewerEntryOf,
  segmentStartOf,
} from "../../workflow/refiner/stage-refiner";
import { isTaskFinished } from "../../workflow/store/state";
import type { ArtifactRow, TaskRow } from "../../workflow/store/tasks";
import type { WorkflowRuntime } from "../../workflow/types";

const jobIdField = z.string().describe("the job id, for example wf_abc-2");

/** How the agent routes a reviewed artifact. Kept next to the tools that route it. */
export const REVIEW_RULES = `## Review & Refinement Protocol

### Reviewer Segment Routing
* **Hold** artifacts internally during stage refiner runs; do not expose to humans until the reviewer sequence is fully resolved.
* **Inspect** author modifications upon turn completion using \`read_task\` on the author task (and \`read_artifact\` on the job if diff context is insufficient).
* **Call** \`request_review\` to re-run the open reviewer segment from the first entry if changes require verification or author defenses require the segment to run again.
* **Call** \`finish_review\` to finalize the open segment and advance to the next entry if findings are resolved, non-blocking polish, or reserved for human review.
* **Call** \`cancel_task\` on the reviewer run if a reviewer hangs or a human requests termination. (The entry remains open: invoke \`request_review\` to retry or \`finish_review\` to bypass).

### Judge Entry Resolution
* **Allow** code automation to handle judge routing on an approved or rejected ruling; judge entries run exactly once per artifact.
* **Escalate** to the thread when the system flags a judge conclusion that gives no ruling.
* **Call** \`rule_on_review\` strictly using the human's decision; never determine the ruling independently.
* **Call** \`request_review\` on a judge entry only when re-executing it after an explicit \`cancel_task\`.

### Post-Release Job Follow-Up & Rewrites
* **Dispatch** follow-up edits to the author task of the existing job using \`prompt_task\`.
  * The job's board moves to the end of the thread as soon as the author gets the follow-up, and tracks it.
  * Refiners automatically re-run from the top if the artifact changes (excluding single-run judge entries).
  * Refiners do not run if the artifact is unchanged.
* **Dispatch** complete artifact rewrites as a new job via \`start_job\` so the rewrite gets its own board.

### Polisher Entry Execution
* **Allow** polisher entries to run and update the artifact in place after reviewers complete; no manual routing is permitted.
* **Call** \`cancel_task\` on the polisher run to stop it when requested; the branch immediately releases the partial diff to the humans.

### Invariants & Exclusions
* **Prohibit Refiner Chatter**: Never prompt, message, or reply to active refiner runs.
* **Prohibit Manual Judge Overrides**: Never invoke \`finish_review\` or \`request_review\` on judge entries, except to restart a cancelled judge via \`request_review\`.
* **Prohibit Autonomous Adjudication**: Never resolve ambiguous judge findings without escalating to the thread and relaying via \`rule_on_review\`.
* **Prohibit Polisher Interference**: Never attempt to route or manually advance polisher entries; all routing calls are rejected.
* **Prohibit Author Re-use for Rewrites**: Never route whole-artifact rewrites through the author task of an existing job.`;

/** The tools that read an artifact and decide where it goes next. */
export function artifactTools(workflow: WorkflowRuntime) {
  return {
    request_review: tool({
      description:
        "Re-run the open reviewer segment of a job's artifact from its first entry. Refused while the author is mid-turn, while a refiner is running, once the reviewers reached their run limit, and once the humans have the artifact.",
      inputSchema: z.object({ job_id: jobIdField }),
      execute: ({ job_id }) => requestReview(workflow, job_id),
    }),
    finish_review: tool({
      description:
        "End the open reviewer segment of a job's artifact and hand the artifact on: the next declared entry runs, and when the list is exhausted the humans have it. Use it when the open segment's findings are settled or what is left open is for a human to rule on.",
      inputSchema: z.object({ job_id: jobIdField }),
      execute: ({ job_id }) => finishReview(workflow, job_id),
    }),
    rule_on_review: tool({
      description:
        "Record a person's ruling on a judge entry that waits for one. `approve` hands the artifact on. `reject` sends the person's reason to the author. Call it only with a ruling a person gave in their own words.",
      inputSchema: z.object({
        job_id: jobIdField,
        ruling: z.enum(["reject", "approve"]),
        reason: z.string().optional().describe("why the person rejects. Required with reject."),
      }),
      execute: ({ job_id, ruling, reason }) => ruleOnReview(workflow, job_id, ruling, reason),
    }),
    read_artifact: tool({
      description: "A job's artifact as the host has it now.",
      inputSchema: z.object({ job_id: jobIdField }),
      execute: ({ job_id }) => readArtifact(workflow, job_id),
    }),
  };
}

/** The author and artifact of a job the review still holds, or the refusal to send back. */
function heldJob(
  workflow: WorkflowRuntime,
  jobId: string,
): { author: TaskRow; artifact: ArtifactRow } | string {
  if (!workflow.store.job(jobId)) return `Job ${jobId} does not exist.`;
  const artifact = workflow.store.artifact(jobId);
  if (!artifact) return `Job ${jobId} has no artifact yet.`;
  if (!heldForReview(workflow, artifact)) {
    return `The agent review of job ${jobId} is over and the humans have ${artifact.external_url}.`;
  }
  return { author: workflow.store.authorTaskOf(jobId), artifact };
}

async function requestReview(workflow: WorkflowRuntime, jobId: string): Promise<string> {
  const held = heldJob(workflow, jobId);
  if (typeof held === "string") return held;
  const { author, artifact } = held;
  const polishing = polisherRefusal(workflow, author);
  if (polishing) return polishing;
  if (refinerInFlight(workflow, jobId)) {
    return `A review is already running on job ${jobId} as ${artifact.refiner_task_id}. You are told what it finds. cancel_task on it stops it.`;
  }
  if (isTaskFinished(author.status)) {
    return `The author ${author.task_id} of job ${jobId} is ${author.status}, so nobody would answer the findings. Call finish_review instead.`;
  }
  if (!taskQuiet(workflow, author)) {
    return `The author ${author.task_id} is still working. You are told when its turn ends.`;
  }
  const pointer = refinerRunOf(workflow, artifact);
  if (!pointer) return `No reviewer entry is open on job ${jobId}.`;
  if (isJudgeRun(workflow, pointer) && pointer.status !== "cancelled") {
    return JUDGE_ENTRY_REFUSAL;
  }
  const stage = workflow.stageForTask(author);
  const index = refinerIndexOf(pointer);
  if (refinerAt(stage, index)?.role !== "reviewer") {
    return `The open entry on job ${jobId} is a polisher, not a reviewer, so there is no segment to re-run. Call finish_review to hand the artifact on.`;
  }
  if (reviewLimitReached(workflow, pointer)) {
    return `The reviewers of job ${jobId} reached the limit of ${workflow.config().orchestrator.max_review_runs} runs. Call finish_review to hand the artifact on.`;
  }
  await startRefiner(workflow, author, segmentStartOf(index, stage.reviewers));
  return `A review started on job ${jobId}.`;
}

async function finishReview(workflow: WorkflowRuntime, jobId: string): Promise<string> {
  const held = heldJob(workflow, jobId);
  if (typeof held === "string") return held;
  const { author, artifact } = held;
  const polishing = polisherRefusal(workflow, author);
  if (polishing) return polishing;
  if (refinerInFlight(workflow, jobId)) {
    return `A review is already running on job ${jobId} as ${artifact.refiner_task_id}. You are told what it finds. cancel_task on it stops it.`;
  }
  const pointer = refinerRunOf(workflow, artifact);
  if (!pointer) return `No reviewer entry is open on job ${jobId}.`;
  if (isJudgeRun(workflow, pointer)) return JUDGE_ENTRY_REFUSAL;
  if (!taskQuiet(workflow, author)) {
    return `The author ${author.task_id} is still working. You are told when its turn ends.`;
  }
  return advanceArtifactPastEntry(workflow, author, refinerIndexOf(pointer));
}

const JUDGE_ENTRY_REFUSAL =
  "The open entry is a judge entry, and code routes it. A person's ruling goes through rule_on_review.";

function isJudgeRun(workflow: WorkflowRuntime, run: TaskRow): boolean {
  return reviewerEntryOf(workflow, run)?.mode === "judge";
}

async function ruleOnReview(
  workflow: WorkflowRuntime,
  jobId: string,
  ruling: "reject" | "approve",
  reason: string | undefined,
): Promise<string> {
  const held = heldJob(workflow, jobId);
  if (typeof held === "string") return held;
  const { author, artifact } = held;
  const pointer = refinerRunOf(workflow, artifact);
  if (!pointer || !isJudgeRun(workflow, pointer)) {
    return `No judge entry is open on job ${jobId}, so there is nothing to rule on.`;
  }
  if (!isTaskFinished(pointer.status)) {
    return `The judge review still runs on job ${jobId} as ${pointer.task_id}. Code rules on it when it ends.`;
  }
  if (judgeRejected(pointer)) {
    return `Job ${jobId} already has a rejection. The next entry runs when its turn ends.`;
  }
  if (ruling === "approve") {
    return applyJudgeRuling(workflow, { author, reviewer: pointer, ruling: "approved" });
  }
  if (!reason?.trim()) return "A rejection needs the person's reason. Ask them for it.";
  return applyJudgeRuling(workflow, {
    author,
    reviewer: pointer,
    ruling: "rejected",
    reason: reason.trim(),
  });
}

async function readArtifact(workflow: WorkflowRuntime, jobId: string): Promise<string> {
  const artifact = workflow.store.artifact(jobId);
  if (!artifact) return `Job ${jobId} has no artifact.`;
  return workflow
    .artifact(artifact.kind)
    .describe({ ref: artifact.ref, url: artifact.external_url });
}
