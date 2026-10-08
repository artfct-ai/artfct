import type {
  DecisionAnswers,
  DecisionQuestions,
  DecisionState,
  YesNoQuestion,
} from "@artfct-ai/adapters/gateway/types";
import type { WorkflowRuntime } from "../workflow/types";

/** The answers to one decisions call, without its usage. */
export type Decided<YesNoName extends string, ChoiceName extends string> = Omit<
  DecisionAnswers<YesNoName, ChoiceName>,
  "usage"
>;

/**
 * The decisions calls of one agent turn. `signal` is the turn's. Once a call fails, `failed` is
 * true, and every later call of the turn takes its fallback without asking the model.
 */
export type TurnDecisions = { signal: AbortSignal; failed: boolean };

/**
 * One decisions call. `purpose` names its usage record. A caller inside an agent turn passes the
 * turn's decisions.
 */
export type DecisionsAsk<Questions> = {
  purpose: string;
  state: DecisionState;
  questions: Questions;
  turn?: TurnDecisions;
};

/**
 * Ask the orchestrator's decisions model every question over one state in one call, and record
 * the usage. Null when the orchestrator's gateway is missing a secret, or every configured model
 * failed, or the call aborts or runs past its deadline, or an earlier call of the turn failed.
 */
export async function askDecisions<YesNoName extends string, ChoiceName extends string>(
  workflow: WorkflowRuntime,
  { purpose, state, questions, turn }: DecisionsAsk<DecisionQuestions<YesNoName, ChoiceName>>,
): Promise<Decided<YesNoName, ChoiceName> | null> {
  const decisions = workflow.decisions();
  if (!decisions) return null;
  if (turn?.failed) {
    workflow.log(null, `${purpose} unknown, a decisions call failed earlier in the turn`);
    return null;
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`decisions deadline of ${decisions.deadlineMs} ms passed`)),
    decisions.deadlineMs,
  );
  const callSignal = turn ? AbortSignal.any([turn.signal, deadline.signal]) : deadline.signal;
  try {
    const { usage, ...answers } = await decisions.decide(state, questions, callSignal);
    workflow.store.recordModelUsage({ purpose, ...usage });
    return answers;
  } catch (error) {
    if (turn) turn.failed = true;
    workflow.log(null, `${purpose} unknown, decisions failed: ${String(error).slice(0, 200)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask only yes-or-no questions. The probability of yes for each, or null as `askDecisions`. */
export async function askYesNo<Name extends string>(
  workflow: WorkflowRuntime,
  ask: DecisionsAsk<Record<Name, YesNoQuestion>>,
): Promise<Record<Name, number> | null> {
  const answers = await askDecisions(workflow, {
    ...ask,
    questions: { yesNo: ask.questions, choices: {} },
  });
  return answers?.probabilities ?? null;
}
