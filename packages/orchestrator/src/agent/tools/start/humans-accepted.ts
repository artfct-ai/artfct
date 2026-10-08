import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import { askYesNo, type TurnDecisions } from "../../../decisions/ask";
import type { WorkflowRuntime } from "../../../workflow/types";

/** The `purpose` a humans-accepted call records its usage under. */
export const HUMANS_ACCEPTED_PURPOSE = "humans_accepted";

const ACCEPTED_FLOOR = 0.7;

const ACCEPTS: YesNoQuestion = {
  instructions:
    "A person was given the work named in `artifact` to look at. `messages` holds what the person wrote since. Do the words in `messages` accept that work, so the next step can start? A person who tells you to act on the work accepts it. They do not need to say the word accept.",
  yes: "The person approves the work, says it looks good, says to ship it, or answers with a check mark, a thumbs up, or a bare 'ok'. Or the person tells you to go on, to start the next step, or to start working on or through the work, in any wording or slang, such as 'go ahead', 'start on these', or 'start burning them down'. Or the person says an earlier instruction to go on was their approval. An approval with a small fix to make whenever counts as yes.",
  no: "The person asks for a change first, asks a question, says to wait or hold off, takes an approval back, writes about something else, or says nothing about the work. Thanks or praise alone, such as 'thanks for the design!', counts as no, because it neither approves the work nor says to go on.",
};

/** True when the probability says the humans accepted the artifact. */
export function acceptedAt(probability: number): boolean {
  return probability >= ACCEPTED_FLOOR;
}

/**
 * The input to `humansAccepted`. `artifact` is the URL of the artifact the humans hold, and
 * `messages` is what they wrote in this turn. Pass the agent turn's decisions.
 */
export type Acceptance = { artifact: string; messages: string[]; turn?: TurnDecisions };

/**
 * Ask the decisions model whether the person's messages of this turn accept the artifact. Null
 * when no answer came.
 */
export async function humansAccepted(
  workflow: WorkflowRuntime,
  { artifact, messages, turn }: Acceptance,
): Promise<boolean | null> {
  const probabilities = await askYesNo(workflow, {
    purpose: HUMANS_ACCEPTED_PURPOSE,
    state: { artifact, messages: messages.join("\n\n") },
    questions: { accepts: ACCEPTS },
    turn,
  });
  if (!probabilities) return null;
  workflow.log(null, `humans accepted: ${probabilities.accepts.toFixed(2)}`);
  return acceptedAt(probabilities.accepts);
}
