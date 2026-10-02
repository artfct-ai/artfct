import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import { askYesNo } from "../../decisions/ask";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/** The `purpose` a review again decision records its usage under. */
export const REVIEW_AGAIN_PURPOSE = "review_again";

const REVIEW_AGAIN_FLOOR = 0.7;

const REVIEW_AGAIN: YesNoQuestion = {
  instructions:
    "An author revised a document after an agent review. It ended its turn with `closing_text`. Does the author in `closing_text` ask for the reviewers to run again?",
  yes: "The author asks for another review, says a review is needed, or names something the reviewers should check again.",
  no: "The author says the changes were straightforward and need no review.",
};

/** True when the probability says the author asked for the reviewers to run again. */
export function reviewAgainAt(probability: number): boolean {
  return probability >= REVIEW_AGAIN_FLOOR;
}

/**
 * The review again decision: ask the decisions model whether the closing text of a model-call
 * author asks for the reviewers to run again. Null when no answer came.
 */
export async function authorAskedForReview(
  workflow: WorkflowRuntime,
  author: TaskRow,
): Promise<boolean | null> {
  const probabilities = await askYesNo(
    workflow,
    REVIEW_AGAIN_PURPOSE,
    { closing_text: author.summary },
    { review_again: REVIEW_AGAIN },
  );
  if (!probabilities) return null;
  workflow.log(author.task_id, `review again: ${probabilities.review_again.toFixed(2)}`);
  return reviewAgainAt(probabilities.review_again);
}
