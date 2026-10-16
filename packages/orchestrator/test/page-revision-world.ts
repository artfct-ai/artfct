import type { DocumentsMethod, FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { labeledPageCommentIds } from "../src/artifact/page-comment-label";
import { CLOSING_TEXT_MARKER, replyMarker } from "../src/prompts/model-author-prompt";
import { feedbackText } from "../src/prompts/review-prompt";
import { heldCommentFindings } from "../src/workflow/refiner/held-comments";
import { reviseModelAuthorPage } from "../src/workflow/task/model-author";
import { EchoModel } from "./fake-model";
import {
  PAGE_PARENT,
  patchModelExecution,
  patchStageReviewers,
  seedModelAuthor,
  type FakeRuntime,
} from "./fake-runtime";

/** What the revise model does to one line of the page it reads. */
type LineStep = { lineIndex: number; kind: "change" | "delete" | "insert_after" };

/** How the revise model answers one revise call. */
export type ModelPlan = {
  steps: LineStep[];
  /** The position, among the comments the prompt labels, of one the answer does not reply to. */
  skippedReply: number | null;
  /** True when the answer also replies to a comment the prompt does not label. */
  strayReply: boolean;
};

/** A host method a revision action can make fail once. */
type FailingMethod = Extract<
  DocumentsMethod,
  "readPageContent" | "replyToComment" | "updatePageContent"
>;

/** One step of a page revision sequence. */
export type RevisionAction =
  | { kind: "comment"; lineIndex: number | null; text: string }
  | { kind: "fail_next"; method: FailingMethod }
  | { kind: "revise"; plan: ModelPlan };

/** What the revise model read and answered in one call. */
type ModelAnswer = {
  sentCommentIds: string[];
  replyCount: number;
  /** The ids of the lines the answer left as they were, from the page it read. */
  keptLineIds: number[];
  insertions: number;
};

/** One revise action as an observer saw it. */
type ObservedRevision = {
  answer: ModelAnswer | null;
  repliesPosted: number;
  pageBefore: string | undefined;
  pageAfter: string | undefined;
  lineIdsBefore: number[];
  lineIdsAfter: number[];
};

/** When the revise model read a comment: the host event count at that moment. */
type CommentSent = { commentId: string; atEvent: number };

/** A model-call author on a page with person comments, a revise model, and what it saw. */
export type PageRevisionWorld = {
  workflow: FakeRuntime;
  documents: FakeDocuments;
  pageId: string;
  plan: ModelPlan;
  answer: ModelAnswer | null;
  sent: CommentSent[];
  revisions: ObservedRevision[];
  textSeq: number;
};

const AUTHOR = "wf_x.1";

/** A world whose author has a page of `lineCount` distinct lines in review. */
export async function pageRevisionWorld(
  workflow: FakeRuntime,
  lineCount: number,
): Promise<PageRevisionWorld> {
  const documents = patchModelExecution(workflow);
  patchStageReviewers(workflow, []);
  seedModelAuthor(workflow);
  const lines = [...Array(lineCount).keys()].map((index) => `[line ${index}]`);
  const page = await documents.createPage("Add SSO (design)", lines.join("\n"), PAGE_PARENT);
  workflow.store.upsertArtifact({
    job_id: "wf_x-1",
    kind: "page",
    external_url: page.url,
    ref: { kind: "page", page_id: page.id },
  });
  workflow.store.advanceArtifact("wf_x-1", ["drafted"], "ready");
  const world: PageRevisionWorld = {
    workflow,
    documents,
    pageId: page.id,
    plan: { steps: [], skippedReply: null, strayReply: false },
    answer: null,
    sent: [],
    revisions: [],
    textSeq: 0,
  };
  workflow.modelInstance = new EchoModel((userText) => reviseAnswer(world, userText));
  return world;
}

/** Run one action against the world. */
export async function runRevisionAction(
  world: PageRevisionWorld,
  action: RevisionAction,
): Promise<void> {
  switch (action.kind) {
    case "comment":
      return addComment(world, action.lineIndex, action.text);
    case "fail_next":
      return world.documents.failNext(action.method);
    case "revise":
      return revise(world, action.plan);
    default: {
      const unreachable: never = action;
      throw new Error(`unhandled action ${JSON.stringify(unreachable)}`);
    }
  }
}

function addComment(world: PageRevisionWorld, lineIndex: number | null, text: string): void {
  const lineIds = world.documents.lineIds(world.pageId);
  const lineId = lineIndex === null ? null : (lineIds[lineIndex % lineIds.length] ?? null);
  world.textSeq += 1;
  world.documents.addPersonComment({
    id: `cmt-${world.textSeq}`,
    pageId: world.pageId,
    lineId,
    authorName: "Ann",
    text,
  });
}

async function revise(world: PageRevisionWorld, plan: ModelPlan): Promise<void> {
  const { documents, pageId, workflow } = world;
  const findings = heldCommentFindings(await documents.heldComments(pageId));
  const feedback = findings.length
    ? feedbackText("The people who commented on the page", { body: "", findings })
    : "Tighten the goal.";
  world.plan = plan;
  world.answer = null;
  const pageBefore = documents.pageText(pageId);
  const lineIdsBefore = documents.lineIds(pageId);
  const eventsBefore = documents.events.length;
  workflow.store.updateTask(AUTHOR, { status: "in_review" });
  workflow.store.enqueuePrompt(AUTHOR, feedback);
  await reviseModelAuthorPage(workflow, workflow.store.requireTask(AUTHOR));
  world.revisions.push({
    answer: world.answer,
    repliesPosted: documents.events.slice(eventsBefore).filter((event) => event.kind === "reply")
      .length,
    pageBefore,
    pageAfter: documents.pageText(pageId),
    lineIdsBefore,
    lineIdsAfter: documents.lineIds(pageId),
  });
}

function reviseAnswer(world: PageRevisionWorld, userText: string): string {
  const promptLines = userText.split("\n");
  const pageLines = promptLines.slice(promptLines.lastIndexOf("## Document") + 2);
  const lineIds = world.documents.lineIds(world.pageId);
  const sentCommentIds = labeledPageCommentIds(userText);
  for (const commentId of sentCommentIds) {
    world.sent.push({ commentId, atEvent: world.documents.events.length });
  }
  const stepOf = new Map(
    world.plan.steps.map((step) => [step.lineIndex % pageLines.length, step.kind]),
  );
  const revised: string[] = [];
  const keptLineIds: number[] = [];
  let insertions = 0;
  pageLines.forEach((line, index) => {
    const kind = stepOf.get(index);
    if (kind === "delete") return;
    world.textSeq += 1;
    if (kind === "change") {
      revised.push(`[changed ${world.textSeq}]`);
      return;
    }
    revised.push(line);
    keptLineIds.push(...lineIds.slice(index, index + 1));
    if (kind === "insert_after") {
      revised.push(`[added ${world.textSeq}]`);
      insertions += 1;
    }
  });
  const replyIds = sentCommentIds.filter((commentId, index) => index !== world.plan.skippedReply);
  if (world.plan.strayReply) replyIds.push("cmt-stray");
  world.answer = { sentCommentIds, replyCount: replyIds.length, keptLineIds, insertions };
  return [
    ...revised,
    CLOSING_TEXT_MARKER,
    "Changed what the comments asked.",
    ...replyIds.flatMap((commentId) => [replyMarker(commentId), "Done as you asked."]),
  ].join("\n");
}
