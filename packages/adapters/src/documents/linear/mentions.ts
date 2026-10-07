/** The ProseMirror node type Linear gives a user mention in a comment's body data. */
const USER_MENTION_NODE = "suggestion_userMentions";

type ProseMirrorNode = { type?: string; attrs?: { id?: string }; content?: ProseMirrorNode[] };

/**
 * The ids of the users a Linear comment mentions, read from its ProseMirror body data. The
 * Markdown body shows only `@<display name>`, so it cannot tell a mention from plain text.
 */
export function linearMentionedUserIds(bodyData: string): string[] {
  return userMentionIds(JSON.parse(bodyData) as ProseMirrorNode);
}

function userMentionIds(node: ProseMirrorNode): string[] {
  const own = node.type === USER_MENTION_NODE && node.attrs?.id ? [node.attrs.id] : [];
  return [...own, ...(node.content ?? []).flatMap(userMentionIds)];
}
