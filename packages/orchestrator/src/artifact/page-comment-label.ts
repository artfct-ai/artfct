/** The label that names the page comment a finding came from, in the text an author reads. */
export function pageCommentLabel(commentId: string): string {
  return `[comment ${commentId}]`;
}

/** The ids of the page comments a text labels, in order, each once. */
export function labeledPageCommentIds(text: string): string[] {
  const ids = [...text.matchAll(/\[comment ([\w-]+)\]/g)].map((match) => match[1]!);
  return [...new Set(ids)];
}
