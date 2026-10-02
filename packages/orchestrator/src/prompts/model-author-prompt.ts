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

/** The user message of a produce call, which writes the whole page in one answer. */
export function producePagePrompt(options: ModelAuthorSubject): string {
  const instruction = [
    PRODUCE_PAGE_OPENING,
    "You have no tools and no access to the code. Everything you know is in this message and your instructions.",
    "Reply with the document only, in plain Markdown with no LaTeX. The orchestrator gives the page its title, so do not start with a title line.",
  ].join(" ");
  return [instruction, ...subjectLines(options), ...optionsLines(options.context)].join("\n");
}

/** The user message of a revise call: the findings to resolve and the whole page as it is now. */
export function revisePrompt(
  options: ModelAuthorSubject & { findings: string; pageText: string },
): string {
  const instruction = [
    REVISE_OPENING,
    "Reply with the whole revised document in plain Markdown with no LaTeX. Start with its first heading.",
    `After the document, write the line ${CLOSING_TEXT_MARKER} on its own, then your closing text.`,
    "The closing text is one or two sentences. It says what you changed and whether the reviewers should run again.",
    "When the review asked for changes, ask for another review.",
    "After a review that found nothing blocking, or after a person's feedback, say whether the changes were straightforward enough that another review is unnecessary.",
  ].join(" ");
  return [
    instruction,
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
 * A revise answer split at the last closing text marker into the page text and the closing text.
 * Null when the answer has no marker or no closing text after it.
 */
export function splitReviseAnswer(
  answer: string,
): { pageText: string; closingText: string } | null {
  const markerAt = answer.lastIndexOf(CLOSING_TEXT_MARKER);
  if (markerAt < 0) return null;
  const closingText = answer.slice(markerAt + CLOSING_TEXT_MARKER.length).trim();
  if (!closingText) return null;
  return { pageText: answer.slice(0, markerAt).trim(), closingText };
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
