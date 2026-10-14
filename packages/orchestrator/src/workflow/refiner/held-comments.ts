import type { HeldComment } from "@artfct-ai/adapters/documents/types";
import { pageCommentLabel } from "../../artifact/page-comment-label";
import type { FeedbackHandle, Finding } from "../../artifact/types";
import type { TurnDecisions } from "../../decisions/ask";
import { screenText, type Screened } from "../../decisions/screen";
import { feedbackText } from "../../prompts/review-prompt";
import { isTaskFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import { promptTask } from "../task/harness/prompt-queue";
import type { WorkflowRuntime } from "../types";

/** Each held comment as a finding that labels the comment and says who wrote it. */
export function heldCommentFindings(comments: HeldComment[]): Finding[] {
  return comments.map((comment) => ({
    location: pageCommentLabel(comment.id),
    body: `${comment.author_name ?? "Someone"}: ${comment.text.trim()}`,
  }));
}

/** The held comments to acknowledge on the page once they are sent. */
export function heldCommentHandles(comments: HeldComment[]): FeedbackHandle[] {
  return comments.map((comment) => ({ kind: "page", comment_id: comment.id }));
}

/**
 * The comments held on the page of an author, read from the host and screened. `admitted`
 * carries the text the author reads. The other arms keep the comments held on the page.
 */
export type HeldCommentsRead =
  | { held: "none" }
  | { held: "admitted"; artifact: ArtifactRow; comments: HeldComment[]; text: string }
  | { held: "unreadable"; artifact: ArtifactRow }
  | { held: "unadmitted"; artifact: ArtifactRow; screened: Exclude<Screened, "admitted"> };

const NONE_HELD: HeldCommentsRead = { held: "none" };

/** The lead of the prompt that sends held comments when a person asks for a revision. */
export const REVISION_REQUEST_PROMPT =
  "A person finished reviewing the page and asked for a revision. Revise the page from the comments people left on it.";

/**
 * Read the comments held on the page of the author's job, and screen them. An author whose
 * artifact is not a page, or whose kind holds no comments, has none held.
 */
export async function readHeldComments(
  workflow: WorkflowRuntime,
  author: TaskRow,
  turn?: TurnDecisions,
): Promise<HeldCommentsRead> {
  const artifact = workflow.store.artifact(author.job_id);
  if (artifact?.ref.kind !== "page") return NONE_HELD;
  const support = workflow.artifact(artifact.kind).heldComments;
  if (!support) return NONE_HELD;
  let comments: HeldComment[];
  try {
    comments = await support.read(artifact.ref.page_id);
  } catch (error) {
    workflow.log(author.task_id, `held comments unreadable: ${String(error).slice(0, 200)}`);
    return { held: "unreadable", artifact };
  }
  if (!comments.length) return NONE_HELD;
  const text = feedbackText("The people who commented on the page", {
    body: "",
    findings: heldCommentFindings(comments),
  });
  const screened = await screenText(workflow, {
    source: `the held comments of job ${author.job_id}`,
    text,
    turn,
  });
  if (screened !== "admitted") return { held: "unadmitted", artifact, screened };
  return { held: "admitted", artifact, comments, text };
}

/**
 * Queue `text` for the author with the admitted held comments after it, then mark those
 * comments read on the page. Comments in any other arm stay held. The author is read again
 * from the store, because it may have finished while the comments were read. False when it did,
 * and nothing was queued or marked read.
 */
export async function promptWithHeldComments(
  workflow: WorkflowRuntime,
  authorId: string,
  text: string,
  held: HeldCommentsRead,
): Promise<boolean> {
  const author = workflow.store.requireTask(authorId);
  if (isTaskFinished(author.status)) return false;
  if (held.held !== "admitted") {
    await promptTask(workflow, author, text);
    return true;
  }
  const { artifact, comments } = held;
  await workflow.artifact(artifact.kind).acknowledge(heldCommentHandles(comments), artifact.ref);
  await promptTask(workflow, author, `${text}\n\n${held.text}`);
  workflow.log(author.task_id, `sent ${comments.length} held comments`);
  return true;
}

/** What the agent reads about the held comments of one prompt. Empty when none were held. */
export function heldCommentsNote(held: HeldCommentsRead): string {
  switch (held.held) {
    case "none":
      return "";
    case "admitted": {
      const count = held.comments.length;
      return `It carries the ${count} comment${count === 1 ? "" : "s"} held on ${held.artifact.external_url}, now marked read on the page.`;
    }
    case "unreadable":
      return `The comments held on ${held.artifact.external_url} could not be read, so they were not sent. They stay held. Tell the person.`;
    case "unadmitted":
      return unadmittedHeldCommentsNote(held.artifact.external_url, held.screened);
    default: {
      const unreachable: never = held;
      throw new Error(`unhandled held comments ${JSON.stringify(unreachable)}`);
    }
  }
}

function unadmittedHeldCommentsNote(url: string, screened: Exclude<Screened, "admitted">): string {
  const kept = "They stay held. Tell the person.";
  switch (screened) {
    case "quarantined":
      return `The comments held on ${url} were not sent. The screen found text in them that looks written to steer an AI agent. ${kept}`;
    case "unchecked":
      return `The comments held on ${url} were not sent. The screen could not check them right now. ${kept}`;
    case "too_large":
      return `The comments held on ${url} are too large to screen, so they were not sent. ${kept}`;
    default: {
      const unreachable: never = screened;
      throw new Error(`unhandled screen outcome ${String(unreachable)}`);
    }
  }
}

/** What sending held comments on a person's revision request did: agent notes and the authors prompted. */
export type RevisionRequestSent = { notes: string[]; prompted: string[] };

/**
 * A person asked for a revision. Send the comments held on the page of every running author to
 * that author, and say what happened for the agent. An author with none held gets no prompt.
 */
export async function sendHeldCommentsOnRevisionRequest(
  workflow: WorkflowRuntime,
  turn?: TurnDecisions,
): Promise<RevisionRequestSent> {
  const sent: RevisionRequestSent = { notes: [], prompted: [] };
  const authors = workflow.store
    .activeAuthorAndResearcherTasks()
    .filter((task) => task.role === "author");
  for (const author of authors) {
    const held = await readHeldComments(workflow, author, turn);
    if (held.held === "none") continue;
    if (held.held !== "admitted") {
      sent.notes.push(`The person asked for a revision. ${heldCommentsNote(held)}`);
      continue;
    }
    const prompted = await promptWithHeldComments(
      workflow,
      author.task_id,
      REVISION_REQUEST_PROMPT,
      held,
    );
    if (!prompted) continue;
    sent.prompted.push(author.task_id);
    const count = held.comments.length;
    sent.notes.push(
      `The person asked for a revision, so the system sent the ${count} comment${count === 1 ? "" : "s"} held on ${held.artifact.external_url} to the author ${author.task_id}. The author revises the page now. Do not send them again.`,
    );
  }
  return sent;
}

/**
 * How many comments are held on the page of each running author, by job id, read from the host
 * without screening. Null when the host could not be read. A job without a page is left out.
 */
export async function heldCommentCounts(
  workflow: WorkflowRuntime,
): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>();
  for (const task of workflow.store.activeAuthorAndResearcherTasks()) {
    const artifact = workflow.store.artifact(task.job_id);
    if (task.role !== "author" || artifact?.ref.kind !== "page") continue;
    const support = workflow.artifact(artifact.kind).heldComments;
    if (!support) continue;
    try {
      counts.set(task.job_id, (await support.read(artifact.ref.page_id)).length);
    } catch (error) {
      workflow.log(task.task_id, `held comments unreadable: ${String(error).slice(0, 200)}`);
      counts.set(task.job_id, null);
    }
  }
  return counts;
}
