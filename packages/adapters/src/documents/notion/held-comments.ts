import type { CommentObjectResponse } from "@notionhq/client";
import type { HeldComment } from "../types";

/** The reply that acknowledges a comment. Notion has no reactions. */
export const NOTION_ACKNOWLEDGEMENT = "👀";

/**
 * The comments a person wrote that no acknowledgement marks. Each acknowledgement marks the
 * earliest unmarked person comment before it in its comment thread. Notion rounds comment times
 * to the minute, so the order Notion lists them in decides what comes before.
 */
export function notionHeldComments(
  comments: CommentObjectResponse[],
  selfId: string,
): HeldComment[] {
  const unmarkedByCommentThread = new Map<string, string[]>();
  for (const comment of comments) {
    const unmarked = unmarkedByCommentThread.get(comment.discussion_id) ?? [];
    unmarkedByCommentThread.set(comment.discussion_id, unmarked);
    if (comment.created_by.id !== selfId) unmarked.push(comment.id);
    else if (notionCommentText(comment) === NOTION_ACKNOWLEDGEMENT) unmarked.shift();
  }
  const held = new Set([...unmarkedByCommentThread.values()].flat());
  return comments.flatMap((comment) =>
    held.has(comment.id)
      ? [
          {
            id: comment.id,
            author_name: comment.display_name.resolved_name,
            text: notionCommentText(comment),
          },
        ]
      : [],
  );
}

/** The plain text of a comment. */
export function notionCommentText(comment: CommentObjectResponse): string {
  return comment.rich_text.map((part) => part.plain_text).join("");
}
