/** What the mock agent ends its turn with when the smoke starts it as the reviewer of a page. */

/** The opening of every reviewer prompt. No other prompt in the flow starts this way. */
const REVIEW_OPENING = "You are reviewing";

/** A page id as a page URL carries it: 32 hex characters. */
const PAGE_ID_IN_URL = /[0-9a-f]{32}/;

/** What a filed review opens with, which is how a later run recognizes an earlier one. */
const REVIEW_LINE = /^\s*Review:/;

function findingsReview(passage: string | null): string {
  const quoted = passage ? `"${passage}": ` : "";
  return [
    "Review: findings",
    "The page answers the request. Two things are loose.",
    "",
    `- ${quoted}Rollout: this section covers more than the request asked for.`,
    "- The migration step names no owner.",
  ].join("\n");
}

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

/**
 * The review to end the turn with: findings the first time, approved once a review already
 * stands on the page. The first finding quotes `passage` when the page has one.
 */
export function nextReview(filed: string[], passage: string | null): string {
  return filed.some((text) => REVIEW_LINE.test(text)) ? APPROVED_REVIEW : findingsReview(passage);
}

type Listed = { results: Array<Record<string, unknown>> };

type RichTextOwner = { rich_text?: Array<{ plain_text: string }> };

function plainText(owner: RichTextOwner | undefined): string {
  return (owner?.rich_text ?? []).map((part) => part.plain_text).join("");
}

async function listed(url: string): Promise<Listed | null> {
  const response = await fetch(url);
  return response.ok ? ((await response.json()) as Listed) : null;
}

/** Reads the page and its comments and returns the review. Null when the host cannot be read. */
export async function mockPageReview(documentsUrl: string, pageId: string): Promise<string | null> {
  const comments = await listed(`${documentsUrl}/v1/comments?block_id=${pageId}`);
  const blocks = await listed(`${documentsUrl}/v1/blocks/${pageId}/children`);
  if (!comments || !blocks) return null;
  const filed = comments.results.map((comment) => plainText(comment as RichTextOwner));
  const firstBlock = blocks.results[0];
  const passage = firstBlock
    ? plainText(firstBlock[String(firstBlock.type)] as RichTextOwner | undefined)
    : "";
  return nextReview(filed, passage || null);
}
