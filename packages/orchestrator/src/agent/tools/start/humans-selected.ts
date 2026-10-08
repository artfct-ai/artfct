import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import { askYesNo, type TurnDecisions } from "../../../decisions/ask";
import type { WorkflowRuntime } from "../../../workflow/types";

/** The `purpose` a humans-selected call records its usage under. */
export const HUMANS_SELECTED_PURPOSE = "humans_selected";

const SELECTED_FLOOR = 0.7;

const SELECTS: YesNoQuestion = {
  instructions:
    "A person was given the numbered options in `options` to choose from. `messages` holds what the person wrote since. Do the words in `messages` choose the option named in `option`, and no other?",
  yes: "The person names that option, its number, or its content, and says to go with it.",
  no: "The person chooses another option, chooses more than one, asks a question, asks for a change, stays undecided, or writes about something else.",
};

/**
 * Ask the decisions model whether the person's messages of this turn select one option among the
 * options of the page. Null when no answer came.
 */
export async function humansSelected(
  workflow: WorkflowRuntime,
  selection: { option: string; options: string[]; messages: string[]; turn?: TurnDecisions },
): Promise<boolean | null> {
  const { option, options, messages, turn } = selection;
  const probabilities = await askYesNo(workflow, {
    purpose: HUMANS_SELECTED_PURPOSE,
    state: {
      option,
      options: options.map((listed, index) => `${index + 1}. ${listed}`).join("\n"),
      messages: messages.join("\n\n"),
    },
    questions: { selects: SELECTS },
    turn,
  });
  if (!probabilities) return null;
  workflow.log(null, `humans selected ${option}: ${probabilities.selects.toFixed(2)}`);
  return probabilities.selects >= SELECTED_FLOOR;
}
