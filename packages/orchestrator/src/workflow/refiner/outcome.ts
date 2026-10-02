import { noteMessage } from "../../agent/transcript/envelope";
import type { ArtifactClose, Review } from "../../artifact/types";
import { rejectionPrompt, reviewForAuthorPrompt } from "../../prompts/review-prompt";
import { markBoardDirty } from "../board/board";
import { armIdle } from "../lifecycle";
import { promptTask } from "../task/harness/prompt-queue";
import { isTaskFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";
import { unreviewedRevisionNote } from "./review-limit";

/** Send a review to the author as its next prompt. */
export async function sendReviewToAuthor(
  workflow: WorkflowRuntime,
  author: TaskRow,
  artifact: ArtifactRow,
  review: Review,
): Promise<void> {
  if (isTaskFinished(author.status)) {
    return markArtifactReady(workflow, author.job_id, {
      close: "blocked",
      reason: `The review left findings, but ${author.task_id} is ${author.status}. They are open on the artifact.`,
    });
  }
  const total = review.findings.length;
  workflow.log(
    author.task_id,
    `review left ${total} findings (${review.blocking ? "blocking" : "nothing blocking"})`,
  );
  await promptTask(
    workflow,
    workflow.store.requireTask(author.task_id),
    reviewForAuthorPrompt({
      url: artifact.external_url,
      review,
      replyInstructions: workflow.artifact(artifact.kind).review?.replyInstructions ?? "",
    }),
  );
  await markBoardDirty(workflow, author.job_id);
  await workflow.tellAgent(
    noteMessage(
      `The review of job ${author.job_id} left ${total} finding${total === 1 ? "" : "s"} on ${artifact.external_url}, ${review.blocking ? "blocking" : "blocking nothing"}. The author is answering them. You route the artifact when its turn ends, and you are told when that is. Nothing to do now.`,
    ),
    "none",
  );
}

/** Send a judge entry's rejection to the author task as its next prompt. */
export async function sendRejectionToAuthor(
  workflow: WorkflowRuntime,
  author: TaskRow,
  artifact: ArtifactRow,
  rejection: { entry: string; reason: string },
): Promise<void> {
  if (isTaskFinished(author.status)) {
    return markArtifactReady(workflow, author.job_id, {
      close: "blocked",
      reason: `The ${rejection.entry} judge rejected the artifact, but ${author.task_id} is ${author.status}.`,
    });
  }
  await promptTask(
    workflow,
    workflow.store.requireTask(author.task_id),
    rejectionPrompt({ url: artifact.external_url, ...rejection }),
  );
  await markBoardDirty(workflow, author.job_id);
  await workflow.tellAgent(
    noteMessage(
      `The ${rejection.entry} judge rejected ${artifact.external_url}. ${author.task_id} is answering it, and the next entry runs when its turn ends. Nothing to do now.`,
    ),
    "none",
  );
}

/**
 * Give the artifact to the humans. A healthy close says the kind's one line, and that no reviewer
 * read the last revision when the review limit ended the agent review. A blocked one says what
 * went wrong.
 */
export async function markArtifactReady(
  workflow: WorkflowRuntime,
  jobId: string,
  close: ArtifactClose,
): Promise<void> {
  const artifact = workflow.store.artifact(jobId);
  if (!artifact) return;
  workflow.store.setArtifactRefinerRun(jobId, null);
  if (artifact.status !== "drafted") return;
  const revision = await artifactRevision(workflow, artifact);
  if (!workflow.store.advanceArtifact(jobId, ["drafted"], "ready")) return;
  workflow.log(null, `the artifact of job ${jobId} is handed over`);
  workflow.store.recordHandover(jobId, revision);
  await markBoardDirty(workflow, jobId);
  await workflow.post({
    type: "artifact_ready",
    job_id: jobId,
    artifact_kind: artifact.kind,
    url: artifact.external_url,
    text: await handoverText(workflow, artifact, close),
  });
  await armIdle(workflow);
}

/**
 * An author turn ended on an artifact the humans have. A revision they have not seen makes it
 * a draft again, so the refiner list runs from the top. An unchanged artifact stays with them.
 */
export async function reopenChangedArtifact(
  workflow: WorkflowRuntime,
  jobId: string,
): Promise<void> {
  const artifact = workflow.store.artifact(jobId);
  if (artifact?.status !== "ready") return;
  const revision = await artifactRevision(workflow, artifact);
  if (revision !== null && revision === artifact.delivered_revision) return;
  workflow.store.advanceArtifact(jobId, ["ready"], "drafted");
  workflow.store.setArtifactRefinerRun(jobId, null);
  workflow.log(
    null,
    `the artifact of job ${jobId} changed, so it is a draft again and the refiners run`,
  );
}

/** What the host says the artifact is now. Null when the kind has no revision or the host fails. */
export async function artifactRevision(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow,
): Promise<string | null> {
  const support = workflow.artifact(artifact.kind).review;
  if (!support) return null;
  return support.revision(artifact.ref);
}

/** What the requester thread hears about a closed artifact. */
async function handoverText(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow,
  close: ArtifactClose,
): Promise<string> {
  if (close.close === "ready") {
    const ready = await workflow.artifact(artifact.kind).readyMessage(artifact.external_url);
    const unreviewed = unreviewedRevisionNote(workflow, artifact.job_id);
    return unreviewed ? `${ready}\n${unreviewed}` : ready;
  }
  return `${close.reason} ${artifact.external_url}`;
}
