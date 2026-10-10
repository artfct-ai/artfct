import type { ChoiceQuestion } from "@artfct-ai/adapters/gateway/types";
import { askDecisions } from "../../decisions/ask";
import { openEntryCount } from "../board/render";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";
import { taskWork } from "./gave-up";

/** The `purpose` an author turn outcome records its usage under. */
export const AUTHOR_TURN_PURPOSE = "author_turn";

const AUTHOR_TURN_OUTCOMES = ["finished", "waits_on_person", "blocked", "stopped_early"] as const;

/** How an author left its work when its turn ended on its own. */
export type AuthorTurnOutcome = (typeof AUTHOR_TURN_OUTCOMES)[number];

const OUTCOME_OPTIONS: Record<AuthorTurnOutcome, string> = {
  finished:
    "The agent reports the work it did and does not say that steps are left. A change, a document, or a set of issues it made or changed as asked is finished work.",
  waits_on_person:
    "The agent asks a person a question, or asks a person to choose, decide, or give access, and waits for the answer before it goes on.",
  blocked:
    "The agent says it cannot go on. It was blocked, could not get access, hit an error it could not get past, or ran out of time or budget. For example: 'I could not check out the branch, so I did not make the change.'",
  stopped_early:
    "The agent ended its turn with steps of the work left that it could still do, and it does not wait for a person. It says what it will do next, that a run it started is still going, or that it will check a result later. For example: 'The test suite runs in the background. I will report the result when it finishes.'",
};

const AUTHOR_TURN: ChoiceQuestion = {
  instructions:
    "An agent was given the work in `work`. It ended its turn on its own with the text in `turn_text`. How did the agent leave the work when its turn ended?",
  options: OUTCOME_OPTIONS,
};

/**
 * Ask the decisions model how an author left its work when its turn ended on its own. Without
 * an answer, the author stopped early when its todo list has open entries and its job has no
 * artifact, and finished otherwise.
 */
export async function authorTurnOutcome(
  workflow: WorkflowRuntime,
  author: TaskRow,
): Promise<AuthorTurnOutcome> {
  const answered = author.summary.trim() ? await askAuthorTurn(workflow, author) : null;
  if (answered) return answered;
  const unfinished = openEntryCount(workflow.store.todoRow(author.task_id)?.todos ?? null) > 0;
  const outcome =
    unfinished && !workflow.store.artifact(author.job_id) ? "stopped_early" : "finished";
  workflow.log(author.task_id, `author turn outcome unknown. taken as ${outcome}`);
  return outcome;
}

async function askAuthorTurn(
  workflow: WorkflowRuntime,
  author: TaskRow,
): Promise<AuthorTurnOutcome | null> {
  const answers = await askDecisions(workflow, {
    purpose: AUTHOR_TURN_PURPOSE,
    state: { work: taskWork(workflow, author), turn_text: author.summary },
    questions: { yesNo: {}, choices: { outcome: AUTHOR_TURN } },
  });
  if (!answers) return null;
  const { outcome } = answers.choices;
  workflow.log(author.task_id, `author turn ${outcome.option}: ${outcome.probability.toFixed(2)}`);
  return AUTHOR_TURN_OUTCOMES.find((listed) => listed === outcome.option) ?? null;
}
