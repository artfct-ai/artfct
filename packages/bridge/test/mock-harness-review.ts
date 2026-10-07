/** What the mock agent files when the smoke starts it as the reviewer of a page. */

/** The opening of every reviewer prompt. No other prompt in the flow starts this way. */
const REVIEW_OPENING = "You are reviewing";

/** A page id as a page URL carries it: 32 hex characters. */
const PAGE_ID_IN_URL = /[0-9a-f]{32}/;

/** What a filed review opens with, which is how a later run recognizes an earlier one. */
const REVIEW_LINE = /^\s*Review:/;

const FINDINGS_REVIEW = [
  "Review: findings",
  "The page answers the request. Two things are loose.",
  "",
  "- Rollout: this section covers more than the request asked for.",
  "- The migration step names no owner.",
].join("\n");

const APPROVED_REVIEW = [
  "Review: approved",
  "The findings are settled and the plan is the simplest that resolves the request.",
].join("\n");

/** True when the prompt is a reviewer's, whatever kind of artifact it names. */
export function isReviewPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(REVIEW_OPENING);
}

/** The page a reviewer prompt names. Null when the prompt is not a review of a page. */
export function reviewedPageId(prompt: string): string | null {
  if (!isReviewPrompt(prompt)) return null;
  return PAGE_ID_IN_URL.exec(prompt)?.[0] ?? null;
}

/** The review to file: findings the first time, approved once a review already stands. */
export function nextReview(filed: string[]): string {
  return filed.some((text) => REVIEW_LINE.test(text)) ? APPROVED_REVIEW : FINDINGS_REVIEW;
}

type ListedComments = { results: Array<{ rich_text: Array<{ plain_text: string }> }> };

/** Files one review comment on the page. Returns its first line, or null when the host refused. */
export async function fileMockPageReview(
  documentsUrl: string,
  pageId: string,
): Promise<string | null> {
  const listed = await fetch(`${documentsUrl}/v1/comments?block_id=${pageId}`);
  if (!listed.ok) return null;
  const body = (await listed.json()) as ListedComments;
  const filed = body.results.map((comment) =>
    comment.rich_text.map((part) => part.plain_text).join(""),
  );
  const text = nextReview(filed);
  const posted = await fetch(`${documentsUrl}/v1/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: text } }],
    }),
  });
  if (!posted.ok) return null;
  return text.split("\n")[0]!;
}
