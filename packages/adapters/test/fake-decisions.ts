import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
  DecisionsModels,
  YesNoQuestion,
} from "../src/gateway/types";
import { askModelsInOrder } from "../src/gateway/models-in-order";

/** How long a `HangingDecisions` call hangs before it rejects. Longer than any test turn. */
const FAKE_DECISIONS_DEADLINE_MS = 10_000;

/** The option a `FakeDecisions` picks for a question it has no choice for. */
const FAKE_NO_CHOICE: Choice = { option: "none", probability: 1 };

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
  readonly asked: DecisionState[] = [];
  readonly offered: ChoiceQuestion[] = [];
  readonly yesNoAsked: Record<string, YesNoQuestion>[] = [];

  constructor(
    private readonly answers: FakeAnswers,
    private readonly choices: Record<string, Choice> = {},
  ) {}

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    this.asked.push(state);
    this.yesNoAsked.push(questions.yesNo);
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
      usage: { model: "fake-decisions", input_tokens: 500, output_tokens: 0, cost_usd: 0.00002 },
    };
  }
}

/**
 * A `Decisions` whose one model never answers. Each call rejects once that model runs past
 * `deadlineMs`, or with the abort reason as soon as the caller's signal aborts.
 */
export class HangingDecisions implements Decisions {
  calls = 0;

  constructor(private readonly deadlineMs = FAKE_DECISIONS_DEADLINE_MS) {}

  decide<YesNoName extends string, ChoiceName extends string>(
    _state: DecisionState,
    _questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    this.calls += 1;
    const inOrder = { models: [fakeModelName(0)] as const, budgetMs: this.deadlineMs, signal };
    return askModelsInOrder(inOrder, (_model, modelSignal) =>
      hangUntilAborted<YesNoName, ChoiceName>(modelSignal),
    );
  }
}

/** What one configured decisions model does with every call. */
export type ModelSays = "answers" | "fails" | "hangs";

/** Milliseconds each model of a `ConfiguredModelsDecisions` gets before the next takes over. */
export const FAKE_MODEL_BUDGET_MS = 10;

/**
 * `Decisions` over configured models that each answer from one table, fail, or hang, tried in
 * order as a gateway tries them. Model `n` is named `fake-model-n`.
 */
export class ConfiguredModelsDecisions implements Decisions {
  calls = 0;
  readonly models: DecisionsModels;
  private readonly answering: FakeDecisions;

  constructor(
    private readonly says: readonly [ModelSays, ...ModelSays[]],
    answers: Exclude<FakeAnswers, Error>,
  ) {
    const [, ...rest] = says;
    this.models = [fakeModelName(0), ...rest.map((_, index) => fakeModelName(index + 1))];
    this.answering = new FakeDecisions(answers);
  }

  /** The first model that answers, or null when every model fails. */
  get firstAnswering(): string | null {
    const index = this.says.indexOf("answers");
    return index === -1 ? null : fakeModelName(index);
  }

  decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    this.calls += 1;
    const inOrder = { models: this.models, budgetMs: FAKE_MODEL_BUDGET_MS, signal };
    return askModelsInOrder(inOrder, async (model, modelSignal) => {
      const says = this.says[this.models.indexOf(model)];
      if (says === "fails") throw new Error(`${model} is down`);
      if (says === "hangs") return hangUntilAborted<YesNoName, ChoiceName>(modelSignal);
      const answered = await this.answering.decide(state, questions);
      return { ...answered, usage: { ...answered.usage, model } };
    });
  }
}

function fakeModelName(index: number): string {
  return `fake-model-${index}`;
}

function hangUntilAborted<YesNoName extends string, ChoiceName extends string>(
  signal: AbortSignal,
): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
