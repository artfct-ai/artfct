import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
} from "../src/gateway/types";

/** The option a `FakeDecisions` picks for a question it has no choice for. */
export const FAKE_NO_CHOICE: Choice = { option: "none", probability: 1 };

/** The yes-or-no answers of a `FakeDecisions`: one table, one table per state, or a failure. */
export type FakeAnswers =
  | Record<string, number>
  | Error
  | ((state: DecisionState) => Record<string, number> | Error);

/**
 * `Decisions` that answers every question from fixed tables, or fails. `choices` holds the
 * option picked for each choice question.
 */
export class FakeDecisions implements Decisions {
  readonly model = "fake-decisions";
  readonly asked: DecisionState[] = [];
  readonly offered: ChoiceQuestion[] = [];

  constructor(
    private readonly answers: FakeAnswers,
    private readonly choices: Record<string, Choice> = {},
  ) {}

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    this.asked.push(state);
    const answers = typeof this.answers === "function" ? this.answers(state) : this.answers;
    if (answers instanceof Error) throw answers;
    const probabilities = {} as Record<YesNoName, number>;
    for (const name of Object.keys(questions.yesNo) as YesNoName[]) {
      probabilities[name] = answers[name] ?? 0;
    }
    const choices = {} as Record<ChoiceName, Choice>;
    for (const name of Object.keys(questions.choices) as ChoiceName[]) {
      this.offered.push(questions.choices[name]);
      choices[name] = this.choices[name] ?? FAKE_NO_CHOICE;
    }
    return {
      probabilities,
      choices,
      usage: { input_tokens: 500, output_tokens: 0, cost_usd: 0.00002 },
    };
  }
}

/** `Decisions` whose every call waits until the caller's signal aborts, then rejects with its reason. */
export class HangingDecisions implements Decisions {
  readonly model = "hanging-decisions";
  calls = 0;

  decide<YesNoName extends string, ChoiceName extends string>(
    _state: DecisionState,
    _questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    this.calls += 1;
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}
