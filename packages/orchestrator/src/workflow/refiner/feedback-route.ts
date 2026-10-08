import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import { askYesNo } from "../../decisions/ask";
import type { WorkflowRuntime } from "../types";

/**
 * Who must act on what a person wrote on an artifact. `author` is the task alone, `nobody` is
 * a remark that asks for nothing, and `agent` is everything else.
 */
export type FeedbackRoute = "author" | "nobody" | "agent";

/** The `purpose` a feedback-route call records its usage under. */
export const FEEDBACK_ROUTE_PURPOSE = "feedback_route";

/** At or above this, the comment asks that thing of someone. */
const ASKS_FLOOR = 0.8;
/** At or below this, the comment does not ask it. */
const ASKS_CEILING = 0.15;

/** The questions asked of every comment a person leaves on an artifact. */
export const FEEDBACK_ROUTE_QUESTIONS = {
  for_author: {
    instructions:
      "Does `comment` ask the author of the pull request or document to change it, fix something in it, or explain a choice made in it?",
    yes: "The comment points out a problem, requests a change, or asks a question about the content of the pull request or document.",
    no: "The comment only approves, thanks, praises, or states a plan of the commenter, or it is about something other than the content.",
  },
  beyond_author: {
    instructions:
      "Does `comment` ask for work on an issue, a change to the plan or to an earlier stage, a stop or a pause of the work, a status report, or a reply from a named person?",
    yes: "The comment asks to create, close, or move an issue, to go back to an earlier stage or change the plan, to stop, cancel, or hold the work, to report status, or it addresses a named person or says how the comment itself must be handled.",
    no: "The comment asks only for changes to the code or text under review, or for an explanation of it, or it asks for nothing.",
  },
} satisfies Record<string, YesNoQuestion>;

/** The route two probabilities stand for. Anything short of a clear case is `agent`. */
export function feedbackRouteFrom(probabilities: {
  for_author: number;
  beyond_author: number;
}): FeedbackRoute {
  if (probabilities.beyond_author > ASKS_CEILING) return "agent";
  if (probabilities.for_author >= ASKS_FLOOR) return "author";
  if (probabilities.for_author <= ASKS_CEILING) return "nobody";
  return "agent";
}

/**
 * Ask the decisions model who must act on `comment`. No answer reads as `agent`, so feedback
 * is never sent or dropped on a guess.
 */
export async function feedbackRoute(
  workflow: WorkflowRuntime,
  taskId: string,
  comment: string,
): Promise<FeedbackRoute> {
  const probabilities = await askYesNo(workflow, {
    purpose: FEEDBACK_ROUTE_PURPOSE,
    state: { comment },
    questions: FEEDBACK_ROUTE_QUESTIONS,
  });
  if (!probabilities) return "agent";
  const route = feedbackRouteFrom(probabilities);
  const author = probabilities.for_author.toFixed(2);
  const beyond = probabilities.beyond_author.toFixed(2);
  workflow.log(taskId, `feedback route ${route}: author=${author} beyond=${beyond}`);
  return route;
}
