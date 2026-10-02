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
 * Ask the orchestrator's decisions model every question over one state in one call, and record
 * the usage under `purpose`. Null when the gateway carries no decisions model or the call fails.
 */
export async function askDecisions<YesNoName extends string, ChoiceName extends string>(
  workflow: WorkflowRuntime,
  purpose: string,
  state: DecisionState,
  questions: DecisionQuestions<YesNoName, ChoiceName>,
): Promise<Decided<YesNoName, ChoiceName> | null> {
  const decisions = workflow.decisions();
  if (!decisions) return null;
  try {
    const { usage, ...answers } = await decisions.decide(state, questions);
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
  purpose: string,
  state: DecisionState,
  questions: Record<Name, YesNoQuestion>,
): Promise<Record<Name, number> | null> {
  const answers = await askDecisions(workflow, purpose, state, { yesNo: questions, choices: {} });
  return answers?.probabilities ?? null;
}
