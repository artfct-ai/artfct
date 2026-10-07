import type { CommentObjectResponse } from "@notionhq/client";
import type { HeldComment } from "../types";

/** The reply that acknowledges a comment. Notion has no reactions. */
export const NOTION_ACKNOWLEDGEMENT = "👀";

/**
 * The comments a person wrote that no acknowledgement follows in their discussion. Notion
 * rounds comment times to the minute, so the order Notion lists them in decides what follows.
 */
export function notionHeldComments(
  comments: CommentObjectResponse[],
  selfId: string,
): HeldComment[] {
  const acknowledgedUpTo = new Map<string, number>();
  comments.forEach((comment, index) => {
    if (comment.created_by.id === selfId && notionCommentText(comment) === NOTION_ACKNOWLEDGEMENT) {
      acknowledgedUpTo.set(comment.discussion_id, index);
    }
  });
  return comments.flatMap((comment, index) => {
    if (comment.created_by.id === selfId) return [];
    if (index < (acknowledgedUpTo.get(comment.discussion_id) ?? -1)) return [];
    return [
      {
        id: comment.id,
        author_name: comment.display_name.resolved_name,
        text: notionCommentText(comment),
      },
    ];
  });
}

/** The plain text of a comment. */
export function notionCommentText(comment: CommentObjectResponse): string {
  return comment.rich_text.map((part) => part.plain_text).join("");
}
