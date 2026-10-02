/** How a review is written on GitHub and read back off it. */
import type { CodeReview } from "../types";

/** Word that opens a review body when a finding must block. */
const BLOCKING_MARKER = "BLOCKING:";

/** The GitHub tool calls one review is made of, in order. */
const REPORT_STEPS = [
  [
    '`pull_request_review_write` with `method: "create"` and no `event`. This opens the pending',
    "review. Call it once. An `event` here submits at once and leaves nothing to write on.",
  ].join("\n"),
  [
    '`add_comment_to_pending_review` once per finding. Anchor it with `subjectType: "LINE"` and',
    'the file and line, or `subjectType: "FILE"` when there is no single line. Every finding is a',
    "comment. The body carries only the summary. The `event` says whether the review blocks.",
  ].join("\n"),
  [
    '`pull_request_review_write` with `method: "submit_pending"`, a short summary as `body`, and',
    "the `event` from the rules below. Nothing is posted before this call.",
  ].join("\n"),
];

const REPORT_RULES = [
  `- Use "${BLOCKING_MARKER}" only for a finding that must be fixed before a human reads this`,
  "  pull request. Other findings still reach the author.",
  `- When a finding blocks: start the body with "${BLOCKING_MARKER}" and submit REQUEST_CHANGES.`,
  "  If GitHub rejects REQUEST_CHANGES, submit COMMENT and keep the marker.",
  `- Otherwise: submit COMMENT and do not write "${BLOCKING_MARKER}" anywhere in the body.`,
  "- Write the marker exactly as shown, in capitals, colon included, as the first line. Code reads",
  "  only the first line for it.",
  "- Never submit APPROVE. A human approves this pull request.",
  "- Post one review through the steps above and stop. No issue comment, no `gh pr review`, no",
  "  other tool.",
  "- Put anything that is not the review in the text of your turn.",
].join("\n");

/** True when a submitted GitHub review blocks, by its state or by the marker in its body. */
function blocking(state: string, body: string): boolean {
  const upper = state.toUpperCase();
  if (upper === "CHANGES_REQUESTED") return true;
  if (upper === "APPROVED") return false;
  return opensWithMarker(body);
}

/** True when the first line of the body opens with the blocking marker, markup aside. */
function opensWithMarker(body: string): boolean {
  const opening = body.trimStart().split("\n", 1)[0] ?? "";
  return opening
    .replace(/[>#*_`~]/g, "")
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/, "")
    .trimStart()
    .startsWith(BLOCKING_MARKER);
}

/** Everything about a GitHub review that the pull artifact kind cannot know on its own. */
export const GITHUB_CODE_REVIEW: CodeReview = {
  permissions: { contents: "read", pull_requests: "write", metadata: "read" },
  reportSteps: REPORT_STEPS,
  reportRules: REPORT_RULES,
  blocking,
};
