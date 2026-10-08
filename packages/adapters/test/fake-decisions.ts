import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
  DecisionsModels,
} from "../src/gateway/types";
import { askModelsInOrder, decisionsDeadlineMs } from "../src/gateway/models-in-order";

/** How long a fake decisions call may take before its caller gives up. Longer than any test turn. */
export const FAKE_DECISIONS_DEADLINE_MS = 10_000;

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
  readonly deadlineMs = FAKE_DECISIONS_DEADLINE_MS;
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
      usage: { model: "fake-decisions", input_tokens: 500, output_tokens: 0, cost_usd: 0.00002 },
    };
  }
}

/**
 * A `Decisions` that never answers. Each call rejects with the abort reason once the caller's
 * signal aborts.
 */
export class HangingDecisions implements Decisions {
  calls = 0;

  constructor(readonly deadlineMs = FAKE_DECISIONS_DEADLINE_MS) {}

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
  readonly deadlineMs: number;
  private readonly answering: FakeDecisions;

  constructor(
    private readonly says: readonly [ModelSays, ...ModelSays[]],
    answers: Record<string, number>,
  ) {
    const [, ...rest] = says;
    this.models = [fakeModelName(0), ...rest.map((_, index) => fakeModelName(index + 1))];
    this.deadlineMs = decisionsDeadlineMs(this.models, FAKE_MODEL_BUDGET_MS);
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
