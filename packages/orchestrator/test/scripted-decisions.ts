import type {
  Choice,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
} from "@artfct-ai/adapters/gateway/types";
import { FAKE_DECISIONS_DEADLINE_MS } from "@artfct-ai/adapters/test/fake-decisions";
import { approvesReply, SCRIPTED_REVIEW_REQUEST } from "./scripted-model";

/** The probability the scripted decisions model gives a question it has no script for. */
const UNDECIDED = 0.5;

/** The scripted pick for every choice question: the option that says none of the others fit. */
const NO_CHOICE: Choice = { option: "none", probability: 1 };

/** A deterministic stand-in for the decisions model, beside the scripted orchestrator model. */
export class ScriptedDecisions implements Decisions {
  readonly deadlineMs = FAKE_DECISIONS_DEADLINE_MS;

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    const probabilities = {} as Record<YesNoName, number>;
    for (const name of Object.keys(questions.yesNo) as YesNoName[]) {
      probabilities[name] = scriptedProbability(name, state);
    }
    const choices = {} as Record<ChoiceName, Choice>;
    for (const name of Object.keys(questions.choices) as ChoiceName[]) choices[name] = NO_CHOICE;
    return {
      probabilities,
      choices,
      usage: { model: "scripted", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  }
}

/**
 * Yes or no for the acceptance and selection questions, by what the person wrote, and for the
 * review-again question, by the scripted closing text. The screen admits every text.
 */
export function scriptedProbability(question: string, state: DecisionState): number {
  const messages = state.messages ?? "";
  switch (question) {
    case "accepts":
      return messages.split("\n\n").some((message) => approvesReply(message)) ? 1 : 0;
    case "selects": {
      const option = state.option?.toLowerCase();
      return option && messages.toLowerCase().includes(option) ? 1 : 0;
    }
    case "review_again":
      return state.closing_text === SCRIPTED_REVIEW_REQUEST ? 1 : 0;
    case "takes_control":
    case "impersonates_system":
    case "exfiltrates":
    case "conceals":
      return 0;
    default:
      return UNDECIDED;
  }
}
