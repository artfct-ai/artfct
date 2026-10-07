import type { HeldComment } from "@artfct-ai/adapters/documents/types";
import type { FeedbackHandle, Finding } from "../../artifact/types";

/** Each held comment as a finding that says who wrote it. */
export function heldCommentFindings(comments: HeldComment[]): Finding[] {
  return comments.map((comment) => ({
    body: `${comment.author_name ?? "Someone"}: ${comment.text.trim()}`,
  }));
}

/** The held comments to acknowledge on the page once they are sent. */
export function heldCommentHandles(comments: HeldComment[]): FeedbackHandle[] {
  return comments.map((comment) => ({ kind: "page", comment_id: comment.id }));
}
