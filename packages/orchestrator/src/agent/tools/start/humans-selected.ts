import type { ChoiceQuestion } from "@artfct-ai/adapters/gateway/types";
import { askDecisions, type TurnDecisions } from "../../../decisions/ask";
import type { WorkflowRuntime } from "../../../workflow/types";

/** The `purpose` a humans-selected call records its usage under. */
export const HUMANS_SELECTED_PURPOSE = "humans_selected";

const SELECTED_FLOOR = 0.7;

/** The option that says the messages choose no single listed option. */
const NO_OPTION = "none";

const SELECTED_INSTRUCTIONS =
  "A person was given numbered options to choose from. `messages` holds what the person wrote since. Which option do the words in `messages` choose and say to go with?";

const NO_OPTION_DESCRIPTION =
  "The person does not settle on one option. They ask a question, ask for a change to an option, stay undecided, leave the choice to someone else, choose more than one or combine options, take a choice back, say to wait, or write about something else.";

function selectedQuestion(options: string[]): ChoiceQuestion {
  return {
    instructions: SELECTED_INSTRUCTIONS,
    options: {
      ...Object.fromEntries(options.map((listed, index) => [listed, `Option ${index + 1}.`])),
      [NO_OPTION]: NO_OPTION_DESCRIPTION,
    },
  };
}

/**
 * Ask the decisions model which listed option the person's messages of this turn select. True
 * when it is `option`. Null when no answer came.
 */
export async function humansSelected(
  workflow: WorkflowRuntime,
  selection: { option: string; options: string[]; messages: string[]; turn?: TurnDecisions },
): Promise<boolean | null> {
  const { option, options, messages, turn } = selection;
  const answers = await askDecisions(workflow, {
    purpose: HUMANS_SELECTED_PURPOSE,
    state: { messages: messages.join("\n\n") },
    questions: { yesNo: {}, choices: { selected: selectedQuestion(options) } },
    turn,
  });
  if (!answers) return null;
  const { selected } = answers.choices;
  workflow.log(null, `humans selected ${selected.option}: ${selected.probability.toFixed(2)}`);
  return selected.option === option && selected.probability >= SELECTED_FLOOR;
}
