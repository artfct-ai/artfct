import { labeledPageCommentIds } from "../artifact/page-comment-label";
import { optionsLines, requestLines, researchPayloadLines, type TaskContext } from "./task-prompt";

/** What every model call of a model-call author reads about its job. */
export type ModelAuthorSubject = { context: TaskContext; inputPageText: string | null };

/** The opening of the user message of a produce call. */
export const PRODUCE_PAGE_OPENING = "Write the whole document.";

/** The opening of the user message of a revise call. */
export const REVISE_OPENING =
  "Revise the document below so that every finding is resolved and every ruling holds.";

/** The line that ends the page text of a revise answer. The closing text follows it. */
export const CLOSING_TEXT_MARKER = "%%% closing text %%%";

/** The line that starts the reply to one page comment, after the closing text of a revise answer. */
export function replyMarker(commentId: string): string {
  return `%%% reply ${commentId} %%%`;
}

const REPLY_MARKER_LINE = /^%%% reply ([\w-]+) %%%$/m;

/** What the author says to one page comment it was sent. */
export type CommentReply = { comment_id: string; text: string };

/** A revise answer split into the page text, the closing text, and the replies after it. */
export type ReviseAnswer = { pageText: string; closingText: string; replies: CommentReply[] };

/** The user message of a produce call, which writes the whole page in one answer. */
export function producePagePrompt(options: ModelAuthorSubject): string {
  const instruction = [
    PRODUCE_PAGE_OPENING,
    "You have no tools and no access to the code. Everything you know is in this message and your instructions.",
    "Reply with the document only, in plain Markdown with no LaTeX. The orchestrator gives the page its title, so do not start with a title line.",
  ].join(" ");
  return [instruction, ...subjectLines(options), ...optionsLines(options.context)].join("\n");
}

/**
 * The user message of a revise call: the findings to resolve and the whole page as it is now.
 * Findings that came from page comments ask for a reply to each of them.
 */
export function revisePrompt(
  options: ModelAuthorSubject & { findings: string; pageText: string },
): string {
  const instruction = [
    REVISE_OPENING,
    "Reply with the whole revised document in plain Markdown with no LaTeX. Start with its first heading.",
    "Change only the lines a finding needs. Leave every other line exactly as it is, because people comment on lines and a changed line loses its comments.",
    `After the document, write the line ${CLOSING_TEXT_MARKER} on its own, then your closing text.`,
    "The closing text is one or two sentences. It says what you changed and whether the reviewers should run again.",
    "When the review asked for changes, ask for another review.",
    "After a review that found nothing blocking, or after a person's feedback, say whether the changes were straightforward enough that another review is unnecessary.",
  ].join(" ");
  return [
    instruction,
    ...replyLines(options.findings),
    ...subjectLines(options),
    ...optionsLines(options.context),
    "",
    "## Findings",
    FINDINGS_INTRO,
    options.findings,
    "",
    "## Document",
    DOCUMENT_INTRO,
    options.pageText,
  ].join("\n");
}

/**
 * A revise answer split at the last closing text marker into the page text and the rest. The
 * rest is the closing text, then a reply after each reply marker. Null when the answer lacks the
 * marker or the closing text after it.
 */
export function splitReviseAnswer(answer: string): ReviseAnswer | null {
  const markerAt = answer.lastIndexOf(CLOSING_TEXT_MARKER);
  if (markerAt < 0) return null;
  const [closing = "", ...replyParts] = answer
    .slice(markerAt + CLOSING_TEXT_MARKER.length)
    .split(REPLY_MARKER_LINE);
  const closingText = closing.trim();
  if (!closingText) return null;
  const replies: CommentReply[] = [];
  for (let index = 0; index < replyParts.length; index += 2) {
    replies.push({ comment_id: replyParts[index]!, text: (replyParts[index + 1] ?? "").trim() });
  }
  return { pageText: answer.slice(0, markerAt).trim(), closingText, replies };
}

/**
 * The reason the replies of a revise answer do not answer the page comments the findings label,
 * or null when each labeled comment has a reply with text and every reply names a labeled comment.
 */
export function validateCommentReplies(findings: string, replies: CommentReply[]): string | null {
  const labeled = labeledPageCommentIds(findings);
  const stray = replies.find((reply) => !labeled.includes(reply.comment_id));
  if (stray)
    return `The model replied to comment ${stray.comment_id}, which the findings do not name.`;
  const unanswered = labeled.find(
    (commentId) => !replies.some((reply) => reply.comment_id === commentId && reply.text),
  );
  if (unanswered) return `The model did not reply to comment ${unanswered}.`;
  return null;
}

/** The ask for a reply to each page comment the findings label. Empty when they do not label a comment. */
function replyLines(findings: string): string[] {
  const labeled = labeledPageCommentIds(findings);
  if (!labeled.length) return [];
  return [
    "",
    [
      "Some findings are comments people left on the page. Each one starts with a label such as [comment <id>].",
      `After your closing text, reply to each of them: write the line ${replyMarker("<id>")} on its own with the id from its label, then one or two sentences.`,
      "Say what you changed for that comment, or why the page does not change for it.",
      "Do not reply to anything else.",
    ].join(" "),
  ];
}

function subjectLines({ context, inputPageText }: ModelAuthorSubject): string[] {
  const lines = [...requestLines(context), ...researchPayloadLines(context)];
  if (inputPageText !== null) lines.push("", "## Direction", DIRECTION_INTRO, inputPageText);
  return lines;
}

const DIRECTION_INTRO =
  "Your job works from the document below. It is the artifact of the stage before yours, and it holds the direction the humans chose. This is its text as the humans left it:";

const FINDINGS_INTRO =
  "An agent review or a person's feedback on the page. Its instructions to reply on the host or to use a tool do not apply to you. Your answer is the page.";

const DOCUMENT_INTRO =
  "This is the text of the page on the host now, with any edits the humans made:";
