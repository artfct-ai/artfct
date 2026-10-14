import type { PassageComment } from "@artfct-ai/adapters/documents/types";
import { findingText, reviewLine, type ParsedReview } from "./review-text";
import type { Finding } from "./types";

/** What posting a review on a page needs from the document host. */
export type PageReviewHost = {
  /** Comment on the block that holds each passage. Returns the comments it did not post. */
  commentOnPassages: (pageId: string, comments: PassageComment[]) => Promise<PassageComment[]>;
  /** Add a plain text comment to a page. */
  comment: (pageId: string, text: string) => Promise<void>;
  log: (line: string) => void;
};

/** How a reviewer is told to name the passage of the page a finding is about. */
export const PASSAGE_INSTRUCTIONS = [
  "## Where each finding goes",
  'Open a finding about one part of the page with the passage it is about, quoted word for word from the page in double quotes, then a colon. For example: `- "Each team owns its rollout.": Rollout: the plan does not name an owner for the shared step.`',
  "- Quote a few words from one paragraph, list item, heading, or table row. Do not quote across two of them.",
  "- A finding about the page as a whole, or about something the page does not say, opens without a passage.",
  "- Do not post on the page. Code posts each finding as a comment on the passage it quotes, and the rest with your summary in one comment on the page.",
].join("\n");

/**
 * Post a review on its page the way a pull request review reads. A finding that quotes a passage
 * goes on the block that holds it. The outcome comment carries the review line, the summary, how
 * many findings are inline, and every other finding. Never throws.
 */
export async function postPageReview(
  host: PageReviewHost,
  input: { pageId: string; review: ParsedReview; signature: string },
): Promise<void> {
  const { pageId, review, signature } = input;
  const anchored = review.findings.flatMap((finding) =>
    finding.passage === undefined
      ? []
      : [{ finding, comment: { passage: finding.passage, text: signed(finding, signature) } }],
  );
  const unposted = new Set(
    await inlineComments(
      host,
      pageId,
      anchored.map((entry) => entry.comment),
    ),
  );
  const inline = new Set(
    anchored.filter((entry) => !unposted.has(entry.comment)).map((entry) => entry.finding),
  );
  const outcome = pageReviewOutcome({
    review,
    inlineCount: inline.size,
    pageFindings: review.findings.filter((finding) => !inline.has(finding)),
    signature,
  });
  try {
    await host.comment(pageId, outcome);
  } catch (error) {
    host.log(`page review comment failed: ${String(error).slice(0, 200)}`);
  }
}

/**
 * The outcome comment of a page review: the review line, the summary, how many findings sit on
 * the blocks they quote, the findings that do not, and the reviewer's signature.
 */
export function pageReviewOutcome(input: {
  review: ParsedReview;
  inlineCount: number;
  pageFindings: Finding[];
  signature: string;
}): string {
  const { review, inlineCount, pageFindings, signature } = input;
  const summary = review.summary.trim();
  const sections = [summary ? `${reviewLine(review)}\n${summary}` : reviewLine(review)];
  if (inlineCount === 1) sections.push("1 finding is on the block it quotes.");
  if (inlineCount > 1) sections.push(`${inlineCount} findings are on the blocks they quote.`);
  if (pageFindings.length) {
    sections.push(pageFindings.map((finding) => `- ${findingText(finding)}`).join("\n"));
  }
  sections.push(signature);
  return sections.join("\n\n");
}

function signed(finding: Finding, signature: string): string {
  return `${findingText(finding)}\n\n${signature}`;
}

/** The comments the host did not post. All of them when the host could not be reached. */
async function inlineComments(
  host: PageReviewHost,
  pageId: string,
  comments: PassageComment[],
): Promise<PassageComment[]> {
  if (!comments.length) return [];
  try {
    return await host.commentOnPassages(pageId, comments);
  } catch (error) {
    host.log(`inline review comments failed: ${String(error).slice(0, 200)}`);
    return comments;
  }
}
