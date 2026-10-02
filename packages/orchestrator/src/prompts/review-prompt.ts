import type { ArtifactInstructions, Feedback, Finding, Review } from "../artifact/types";
import { artifactActionSections } from "./artifact-sections";
import type { TaskContext } from "./task-prompt";

const ROLE =
  "You are reviewing a change you did not write. Judge it as written. Do not fix anything, change the artifact, commit, or push.";

type ReviewSubject = {
  url: string;
  title: string;
  request: string;
  brief: string;
  entryInstructions: string;
  artifact: ArtifactInstructions;
  /** The artifacts of the earlier jobs of the workflow, which the reviewed one works from. */
  earlierArtifacts: TaskContext["previous_artifacts"];
  /** What the job's researcher found. Null when the job ran no researcher. */
  researchPayload: string | null;
};

/** The first prompt of a findings reviewer. It gets the request, never the author's story. */
export function reviewPrompt(options: ReviewSubject & { signatureLine: string }): string {
  return [
    ...subjectLines(options),
    "",
    "## Sign what you post",
    "End the text you post with this line, exactly as written, as its own last line:",
    options.signatureLine,
    ...artifactActionSections(options.artifact, ["read", "report"]),
  ].join("\n");
}

const CONCLUSION_HEADING = "## Conclusion";

/** The first prompt of a judge reviewer. It posts nothing and closes with its conclusion. */
export function judgePrompt(options: ReviewSubject): string {
  return [
    ...subjectLines(options),
    ...artifactActionSections(options.artifact, ["read"]),
    "",
    "## How to report",
    "Post nothing on the artifact. Do not file a review or a comment, and do not change anything.",
    `End your turn with one message. Its first line is exactly \`${CONCLUSION_HEADING}\`.`,
    "Under it, say which of your two outcomes you reached and why, in under 1500 characters.",
    "Write it for the author, who reads it without anything else you wrote.",
  ].join("\n");
}

/** What a judge reviewer concluded, read from the end of its turn text. */
export function conclusionOf(turnText: string): string {
  const start = turnText.lastIndexOf(CONCLUSION_HEADING);
  const conclusion = start === -1 ? turnText : turnText.slice(start + CONCLUSION_HEADING.length);
  return conclusion.trim();
}

function subjectLines(subject: ReviewSubject): string[] {
  const { url, title, request, brief, entryInstructions } = subject;
  const lines = [
    ROLE,
    "",
    entryInstructions,
    "",
    "## The artifact",
    url,
    "",
    "## What the change is supposed to do",
    `Title: ${title}`,
  ];
  if (request.trim()) lines.push("", request.trim());
  if (brief.trim())
    lines.push("", "Acceptance criteria and context given to the author:", brief.trim());
  if (subject.earlierArtifacts.length) {
    lines.push("", "## Artifacts from earlier stages");
    for (const earlier of subject.earlierArtifacts) {
      lines.push(`- ${earlier.stage} (${earlier.kind}): ${earlier.url}`);
    }
  }
  if (subject.researchPayload !== null) {
    lines.push("", "## Research payload", REVIEW_RESEARCH_INTRO, subject.researchPayload);
  }
  return lines;
}

const REVIEW_RESEARCH_INTRO =
  "A researcher read the code for this job before the author started. This is what it found, with file and line references:";

/** The prompt sent to the author when a judge entry rejected its artifact. */
export function rejectionPrompt(options: { url: string; entry: string; reason: string }): string {
  return [
    `The ${options.entry} judge rejected your artifact.`,
    options.url,
    "",
    options.reason,
    "",
    "Address the rejection, then update the artifact. The next review reads it when this turn ends.",
  ].join("\n");
}

/** How the author asks for another review, and what happens without the ask. */
const WHAT_HAPPENS_NEXT = [
  "When this turn ends the orchestrator decides where the artifact goes. Close your turn with:",
  "- What you changed.",
  "- What you left open and why.",
  "- Whether the reviewer should look again. Ask when there is work the reviewer has not seen or a",
  "  finding you argued down. Do not ask otherwise.",
  "Without that ask the artifact goes to the humans as it stands.",
].join("\n");

/** The first line of the prompt to the author after a review that asked for changes. */
export const BLOCKING_REVIEW_OPENING = "The review of your artifact asked for changes.";

/** The prompt sent back to the author with what a reviewer found. */
export function reviewForAuthorPrompt(options: {
  url: string;
  review: Review;
  /** Where the author answers a finding it does not act on, in the host's own terms. */
  replyInstructions: string;
}): string {
  const { url, review, replyInstructions } = options;
  const lines = [
    review.blocking
      ? BLOCKING_REVIEW_OPENING
      : "The review of your artifact found nothing blocking and left comments.",
    url,
  ];
  if (review.summary) lines.push("", review.summary);
  lines.push(...findingLines(review.findings));
  lines.push("", ...answerLines(replyInstructions), WHAT_HAPPENS_NEXT);
  return lines.join("\n");
}

/** What a person said about the artifact, for the agent that decides where it goes. */
export function feedbackText(from: string, feedback: Pick<Feedback, "body" | "findings">): string {
  const lines = [`${from} said:`];
  if (feedback.body.trim()) lines.push(feedback.body.trim());
  lines.push(...findingLines(feedback.findings));
  return lines.join("\n");
}

/** What the author does with what a review left: weigh it by its skill, then the mechanics. */
function answerLines(replyInstructions: string): string[] {
  const lines = ["- Weigh each finding the way your skill says before you act on it."];
  if (replyInstructions.trim()) {
    lines.push(
      `- Answer a finding you do not act on where the reviewer will read it: ${replyInstructions.trim()}`,
    );
  }
  lines.push("- Then update the artifact.");
  return lines;
}

function findingLines(findings: Finding[]): string[] {
  if (!findings.length) return [];
  return [
    "",
    "Comments:",
    ...findings.map(
      (finding) => `- ${[finding.location, finding.body.trim()].filter(Boolean).join(" ")}`,
    ),
  ];
}
