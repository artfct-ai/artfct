import type {
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
} from "@artfct-ai/adapters/gateway/types";

/**
 * What lands while one decisions call is out. Null answers the call at once. A promise holds the
 * call until it resolves, then the model it resolves to answers, or the default model on null.
 */
export type WhileCallIsOut = (
  questions: DecisionQuestions<string, string>,
) => Promise<Decisions | null> | null;

/** A decisions model that lets other events land while a call is out, then answers it. */
export class InterleavedDecisions implements Decisions {
  readonly deadlineMs: number;

  constructor(
    private readonly answering: Decisions,
    private readonly meanwhile: WhileCallIsOut,
  ) {
    this.deadlineMs = answering.deadlineMs;
  }

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    const landing = this.meanwhile(questions);
    const answering = (landing ? await landing : null) ?? this.answering;
    return answering.decide(state, questions, signal);
  }
}

/** Let `meanwhile` land while the first call is out. Every later call is answered at once. */
export function onFirstCall(meanwhile: () => Promise<void>): WhileCallIsOut {
  let pending: (() => Promise<void>) | null = meanwhile;
  return () => {
    const landing = pending;
    pending = null;
    return landing ? landing().then(() => null) : null;
  };
}

/** Let `meanwhile` land while the first call that asks the yes-or-no `question` is out. */
export function onFirstCallAsking(
  question: string,
  meanwhile: () => Promise<void>,
): WhileCallIsOut {
  let pending: (() => Promise<void>) | null = meanwhile;
  return (questions) => {
    if (!Object.hasOwn(questions.yesNo, question)) return null;
    const landing = pending;
    pending = null;
    return landing ? landing().then(() => null) : null;
  };
}
