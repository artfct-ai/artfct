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
 * One decisions call: the `purpose` its usage is recorded under, the state, the questions, and
 * the signal that abandons the call. A caller inside an agent turn passes the turn's signal.
 */
export type DecisionsAsk<Questions> = {
  purpose: string;
  state: DecisionState;
  questions: Questions;
  signal?: AbortSignal;
};

/**
 * Ask the orchestrator's decisions model every question over one state in one call, and record
 * the usage. Null when the gateway carries no decisions model, or the call fails or is aborted.
 */
export async function askDecisions<YesNoName extends string, ChoiceName extends string>(
  workflow: WorkflowRuntime,
  { purpose, state, questions, signal }: DecisionsAsk<DecisionQuestions<YesNoName, ChoiceName>>,
): Promise<Decided<YesNoName, ChoiceName> | null> {
  const decisions = workflow.decisions();
  if (!decisions) return null;
  try {
    const { usage, ...answers } = await decisions.decide(state, questions, signal);
    workflow.store.recordModelUsage({ purpose, model: decisions.model, ...usage });
    return answers;
  } catch (error) {
    workflow.log(null, `${purpose} unknown, decisions failed: ${String(error).slice(0, 200)}`);
    return null;
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
