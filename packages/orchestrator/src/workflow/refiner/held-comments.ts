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
function heldCommentHandles(comments: HeldComment[]): FeedbackHandle[] {
  return comments.map((comment) => ({ kind: "page", comment_id: comment.id }));
}

/** The held comments as the screen and the author read them. */
function heldCommentsText(comments: HeldComment[]): string {
  return feedbackText("The people who commented on the page", {
    body: "",
    findings: heldCommentFindings(comments),
  });
}

/**
 * Acknowledge the held comments on the page, in order. Returns the ones the host marked read.
 * The rest stay held.
 */
export async function markHeldCommentsRead(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow,
  comments: HeldComment[],
): Promise<HeldComment[]> {
  const unmarked = await workflow
    .artifact(artifact.kind)
    .acknowledge(heldCommentHandles(comments), artifact.ref);
  const unmarkedIds = new Set(
    unmarked.flatMap((handle) => (handle.kind === "page" ? [handle.comment_id] : [])),
  );
  return comments.filter((comment) => !unmarkedIds.has(comment.id));
}

/**
 * The comments held on the page of an author, read from the host and screened. Only `admitted`
 * comments may go to the author. The other arms keep the comments held on the page.
 */
export type HeldCommentsRead =
  | { held: "none" }
  | { held: "admitted"; artifact: ArtifactRow; comments: HeldComment[] }
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
  const screened = await screenText(workflow, {
    source: `the held comments of job ${author.job_id}`,
    text: heldCommentsText(comments),
    turn,
  });
  if (screened !== "admitted") return { held: "unadmitted", artifact, screened };
  return { held: "admitted", artifact, comments };
}

/**
 * Mark the admitted held comments read on the page, for a prompt to the author. Returns the
 * ones the host marked, which the prompt carries. The author is read again from the store,
 * because it may have finished while the comments were read. Null when it did, and nothing was
 * marked read.
 */
export async function carryHeldComments(
  workflow: WorkflowRuntime,
  authorId: string,
  held: HeldCommentsRead,
): Promise<HeldComment[] | null> {
  if (isTaskFinished(workflow.store.requireTask(authorId).status)) return null;
  if (held.held !== "admitted") return [];
  return markHeldCommentsRead(workflow, held.artifact, held.comments);
}

/** Queue `text` for the author with the held comments it carries after it. */
export async function promptWithHeldComments(
  workflow: WorkflowRuntime,
  authorId: string,
  text: string,
  carried: HeldComment[],
): Promise<void> {
  const author = workflow.store.requireTask(authorId);
  if (!carried.length) return promptTask(workflow, author, text);
  await promptTask(workflow, author, `${text}\n\n${heldCommentsText(carried)}`);
  workflow.log(author.task_id, `sent ${carried.length} held comments`);
}

/**
 * What the agent reads about the held comments of one prompt, given the ones it carries. Empty
 * when none were held.
 */
export function heldCommentsNote(held: HeldCommentsRead, carried: HeldComment[]): string {
  switch (held.held) {
    case "none":
      return "";
    case "admitted":
      return carriedHeldCommentsNote(held.artifact.external_url, held.comments, carried);
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

function carriedHeldCommentsNote(
  url: string,
  comments: HeldComment[],
  carried: HeldComment[],
): string {
  const left = comments.length - carried.length;
  const unmarked = `The host did not mark ${left === comments.length ? "the" : "the other"} ${countOf(left, "comment")} held on ${url} read, so ${left === 1 ? "it was" : "they were"} not sent. They stay held.`;
  if (!carried.length) return `${unmarked} Tell the person.`;
  const sent = `It carries the ${countOf(carried.length, "comment")} held on ${url}, now marked read on the page.`;
  return left ? `${sent} ${unmarked}` : sent;
}

/** A count and its noun, singular for one. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
 * that author, and say what happened for the agent. An author gets a prompt only when the host
 * marked at least one of its held comments read.
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
      sent.notes.push(`The person asked for a revision. ${heldCommentsNote(held, [])}`);
      continue;
    }
    const carried = await carryHeldComments(workflow, author.task_id, held);
    if (carried === null) {
      sent.notes.push(
        `The person asked for a revision, but the author ${author.task_id} finished before the comments held on ${held.artifact.external_url} were sent. They stay held. Tell the person.`,
      );
      continue;
    }
    if (!carried.length) {
      sent.notes.push(`The person asked for a revision. ${heldCommentsNote(held, carried)}`);
      continue;
    }
    await promptWithHeldComments(workflow, author.task_id, REVISION_REQUEST_PROMPT, carried);
    sent.prompted.push(author.task_id);
    const left = held.comments.length - carried.length;
    const stayHeld = left
      ? ` The host did not mark the other ${countOf(left, "comment")} read, so ${left === 1 ? "it was" : "they were"} not sent. They stay held.`
      : "";
    sent.notes.push(
      `The person asked for a revision, so the system sent ${countOf(carried.length, "comment")} held on ${held.artifact.external_url} to the author ${author.task_id}. The author revises the page now. Do not send them again.${stayHeld}`,
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
