import type { HeldComment } from "../types";

/** The reaction that acknowledges a comment. */
export const LINEAR_ACKNOWLEDGEMENT_EMOJI = "eyes";

/**
 * The comments inside a document with their reactions and who left them, which the SDK comment
 * fragment leaves out. Inline comments are bound to the same content id.
 */
export const LINEAR_DOCUMENT_COMMENTS_QUERY = `query DocumentCommentsWithReactions($contentId: ID!, $after: String) {
  comments(first: 100, after: $after, filter: { documentContent: { id: { eq: $contentId } } }) {
    nodes {
      id body resolvedAt
      parent { resolvedAt }
      user { id name }
      reactions { emoji user { id } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** One comment as the document comments query returns it. */
export type LinearDocumentComment = {
  id: string;
  body: string;
  resolvedAt: string | null;
  parent: { resolvedAt: string | null } | null;
  user: { id: string; name: string } | null;
  reactions: Array<{ emoji: string; user: { id: string } | null }>;
};

/** One page of the document comments query. */
export type LinearDocumentCommentsData = {
  comments: {
    nodes: LinearDocumentComment[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

/**
 * The comments a person wrote that carry no acknowledgement from this user, in open threads.
 * A comment without a user came from an integration, not a person.
 */
export function linearHeldComments(
  comments: LinearDocumentComment[],
  selfId: string,
): HeldComment[] {
  return comments.flatMap((comment) => {
    const { user } = comment;
    if (!user || user.id === selfId) return [];
    if (comment.resolvedAt || comment.parent?.resolvedAt) return [];
    const acknowledged = comment.reactions.some(
      (reaction) => reaction.emoji === LINEAR_ACKNOWLEDGEMENT_EMOJI && reaction.user?.id === selfId,
    );
    if (acknowledged) return [];
    return [{ id: comment.id, author_name: user.name, text: comment.body }];
  });
}
