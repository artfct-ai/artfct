import type { PageRevisionWorld } from "./page-revision-world";

function violated(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`);
}

function sentBefore(world: PageRevisionWorld, commentId: string, eventIndex: number): boolean {
  return world.sent.some((sent) => sent.commentId === commentId && sent.atEvent <= eventIndex);
}

/**
 * A revision removes a line that holds a person comment the author was sent only after the
 * author's reply is in that comment's comment thread.
 */
export function sentCommentIsAnsweredBeforeItsLineGoes(world: PageRevisionWorld): void {
  const comments = world.documents.allPersonComments;
  world.documents.events.forEach((event, eventIndex) => {
    if (event.kind !== "lines_removed") return;
    for (const comment of comments) {
      if (comment.lineId === null || !event.lineIds.includes(comment.lineId)) continue;
      if (!sentBefore(world, comment.id, eventIndex)) continue;
      const replied = world.documents.events
        .slice(0, eventIndex)
        .some((earlier) => earlier.kind === "reply" && earlier.commentId === comment.id);
      if (!replied) {
        violated(
          "sentCommentIsAnsweredBeforeItsLineGoes",
          `line ${comment.lineId} of ${comment.id} went without a reply`,
        );
      }
    }
  });
}

/** The author replies only to a comment it was sent. */
export function replyGoesOnlyToASentComment(world: PageRevisionWorld): void {
  world.documents.events.forEach((event, eventIndex) => {
    if (event.kind !== "reply") return;
    if (!sentBefore(world, event.commentId, eventIndex)) {
      violated("replyGoesOnlyToASentComment", `replied to ${event.commentId}`);
    }
  });
}

/**
 * A revision keeps the identity of every line its answer left as it was, except at most one
 * neighbor of each insertion that anchors it. A revision that did not write the page keeps
 * every line.
 */
export function untouchedLinesKeepTheirIdentity(world: PageRevisionWorld): void {
  for (const revision of world.revisions) {
    const written = revision.pageAfter !== revision.pageBefore;
    if (!written || !revision.answer) {
      if (revision.lineIdsAfter.join() !== revision.lineIdsBefore.join()) {
        violated("untouchedLinesKeepTheirIdentity", "a revision without a write changed lines");
      }
      continue;
    }
    const lost = revision.answer.keptLineIds.filter((id) => !revision.lineIdsAfter.includes(id));
    if (lost.length > revision.answer.insertions) {
      violated(
        "untouchedLinesKeepTheirIdentity",
        `${lost.length} untouched lines lost their identity with ${revision.answer.insertions} insertions`,
      );
    }
  }
}

/** A revision that posted fewer replies than its answer holds leaves the page as it was. */
export function failedReplyLeavesThePage(world: PageRevisionWorld): void {
  for (const revision of world.revisions) {
    if (!revision.answer || revision.repliesPosted >= revision.answer.replyCount) continue;
    if (revision.pageAfter !== revision.pageBefore) {
      violated("failedReplyLeavesThePage", "the page changed after a reply was not posted");
    }
  }
}

/**
 * The proposed invariants of a page revision by a model-call author, checked after each action.
 * They wait for the owner's approval before they join the workflow invariants.
 */
export const PAGE_REVISION_INVARIANTS = [
  sentCommentIsAnsweredBeforeItsLineGoes,
  replyGoesOnlyToASentComment,
  untouchedLinesKeepTheirIdentity,
  failedReplyLeavesThePage,
];
