import type { Finding } from "./types";

/** What the first line of a review says. */
const REVIEW_WORDS = ["approved", "findings", "blocking"] as const;

type ReviewWord = (typeof REVIEW_WORDS)[number];

/** What a review says, without the revision the caller reads separately. */
export type ParsedReview = { blocking: boolean; summary: string; findings: Finding[] };

/** Markdown a model wraps a line in. Stripped before the review line is matched. */
const MARKDOWN_NOISE = /[>#*_`~]/g;

/** A list marker at the start of a line, which a model adds to the review line too. */
const LIST_MARKER = /^\s*(?:[-+]|\d+[.)])\s+/;

/** A finding line. Everything after the marker is the finding. */
const FINDING_LINE = /^\s*[-*]\s+(\S.*)$/;

/** A section name in front of a finding. Sentence punctuation keeps prose out of it. */
const FINDING_LOCATION = /^([^:.!?]{1,60}):\s+(\S.*)$/;

/** What a reviewer is told to write, and where to stop. `where` says where the block goes. */
export function reviewInstructions(where: string): string {
  return [
    "## What to write",
    where,
    "",
    "```",
    "Review: findings",
    "One short paragraph on the document as a whole.",
    "",
    "- Scope: the request asks for X and the document answers Y.",
    "- The rollout plan names no owner.",
    "```",
    "",
    `- Line one is exactly one of ${REVIEW_WORDS.map((word) => `"Review: ${word}"`).join(", ")}. Put`,
    "  nothing above it.",
    '- "Review: approved": the document is ready as it stands. List no findings.',
    '- "Review: findings": the findings are the author\'s to weigh.',
    '- "Review: blocking": the document must be fixed before a human reads it.',
    "- Then one short summary paragraph.",
    "- Then one finding per line, each starting with `- `. A finding may open with its section and",
    "  a colon.",
    "- Put every finding on its own line. Code reads only the review line and the finding lines.",
  ].join("\n");
}

/** The review a text carries. Null when its first line is not a review line. */
export function parseReview(text: string): ParsedReview | null {
  const lines = text.split("\n");
  const openingIndex = lines.findIndex((line) => line.trim() !== "");
  if (openingIndex === -1) return null;
  const word = reviewWord(lines[openingIndex]!);
  if (!word) return null;
  const rest = lines.slice(openingIndex + 1);
  const findingsStart = rest.findIndex((line) => FINDING_LINE.test(line));
  const summaryLines = findingsStart === -1 ? rest : rest.slice(0, findingsStart);
  const findings = word === "approved" ? [] : rest.flatMap(findingOf);
  return { blocking: word === "blocking", summary: summaryLines.join("\n").trim(), findings };
}

/**
 * The review a turn text ends with, read from the last review line in it. Null when it
 * has none.
 */
export function parseTurnTextReview(text: string): ParsedReview | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (reviewWord(lines[index]!)) return parseReview(lines.slice(index).join("\n"));
  }
  return null;
}

function reviewWord(line: string): ReviewWord | null {
  const opening = line.replace(MARKDOWN_NOISE, "").replace(LIST_MARKER, "").trim();
  const match = /^review:\s*(\w+)/i.exec(opening);
  const word = match?.[1]?.toLowerCase();
  return REVIEW_WORDS.find((known) => known === word) ?? null;
}

function findingOf(line: string): Finding[] {
  const body = FINDING_LINE.exec(line)?.[1];
  if (body === undefined) return [];
  const located = FINDING_LOCATION.exec(body);
  if (!located) return [{ body: body.trim() }];
  return [{ location: located[1]!.trim(), body: located[2]!.trim() }];
}
