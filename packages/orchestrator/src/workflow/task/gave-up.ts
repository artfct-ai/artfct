import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import type { ArtifactKind } from "@artfct-ai/contracts/types";
import { askYesNo } from "../../decisions/ask";
import type { TaskRow } from "../store/tasks";
import type { TaskRole } from "./events";
import type { WorkflowRuntime } from "../types";

/** The `purpose` a gave-up check records its usage under. */
export const GAVE_UP_PURPOSE = "gave_up";

const GAVE_UP_FLOOR = 0.7;

const ROLE_WORK: Record<Exclude<TaskRole, "author">, string> = {
  researcher: "Research the request and write a research payload.",
  reviewer: "Review one artifact and report what the review found.",
  polisher: "Improve one artifact in place.",
};

/** The work an author does, by the artifact kind of its stage. */
export const AUTHOR_WORK: Record<ArtifactKind, string> = {
  pull: "Change the code and open a pull request, or change the pull request as asked.",
  page: "Write a document, or change the document as asked.",
  issues: "Create a set of issues, or change the issues as asked.",
};

/** The work a task was given, in the words the decisions model reads. */
export function taskWork(workflow: WorkflowRuntime, task: TaskRow): string {
  return task.role === "author"
    ? AUTHOR_WORK[workflow.stageForTask(task).artifact]
    : ROLE_WORK[task.role];
}

const GAVE_UP: YesNoQuestion = {
  instructions:
    "An agent was given the work in `work`. It ended its turn with `turn_text`. Does `turn_text` say that the agent could not do the work, or stopped before it finished the work?",
  yes: "The agent says it was blocked, had no access, hit an error it could not get past, ran out of time or budget, or stopped early. For example: 'I could not check out the branch, so I did not review the change.'",
  no: "The agent reports work it did, or asks a person a question and waits for the answer. A review that finds problems, a review that finds none, a rejection of the artifact, and a polish that changed nothing are all finished work.",
};

/** True when the probability says the harness gave up. */
export function gaveUpAt(probability: number): boolean {
  return probability >= GAVE_UP_FLOOR;
}

/**
 * Ask the decisions model whether the turn text of a researcher or a refiner run says its harness
 * gave up. False when the turn closed with no text, or when no answer came.
 */
export async function harnessGaveUp(workflow: WorkflowRuntime, task: TaskRow): Promise<boolean> {
  if (!task.summary.trim()) return false;
  const probabilities = await askYesNo(workflow, {
    purpose: GAVE_UP_PURPOSE,
    state: { work: taskWork(workflow, task), turn_text: task.summary },
    questions: { gave_up: GAVE_UP },
  });
  if (!probabilities) return false;
  workflow.log(task.task_id, `gave up: ${probabilities.gave_up.toFixed(2)}`);
  return gaveUpAt(probabilities.gave_up);
}
