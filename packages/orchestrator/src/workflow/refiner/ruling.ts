import { noteMessage } from "../../agent/transcript/envelope";
import type { JudgeEntry } from "../../config/refiner";
import { markBoardDirty } from "../board/board";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/** The outcome of a judge entry. */
export type Ruling = "rejected" | "approved";

/** The `purpose` a ruling call records its usage under. */
export const REVIEW_RULING_PURPOSE = "review_ruling";

const REJECTED_FLOOR = 0.7;
const APPROVED_CEILING = 0.3;

/** The ruling for a probability that the reviewer rejected. Null when a person must rule. */
export function rulingForRejectProbability(rejects: number): Ruling | null {
  if (rejects >= REJECTED_FLOOR) return "rejected";
  if (rejects <= APPROVED_CEILING) return "approved";
  return null;
}

/** Ask the decisions model what a judge reviewer concluded. Null when a person must rule. */
export async function ruleOnConclusion(
  workflow: WorkflowRuntime,
  reviewer: TaskRow,
  entry: JudgeEntry,
  conclusion: string,
): Promise<Ruling | null> {
  if (!conclusion) {
    workflow.log(reviewer.task_id, "ruling unknown: the reviewer closed with no conclusion");
    return null;
  }
  const decisions = workflow.decisions();
  if (!decisions) {
    workflow.log(reviewer.task_id, "ruling unknown: the gateway carries no decisions model");
    return null;
  }
  const { question, yes, no } = entry.rejects_when;
  try {
    const { probabilities, usage } = await decisions.decide(
      { conclusion },
      { yesNo: { rejects: { instructions: question, yes, no } }, choices: {} },
    );
    workflow.store.recordModelUsage({
      purpose: REVIEW_RULING_PURPOSE,
      model: decisions.model,
      ...usage,
    });
    const ruling = rulingForRejectProbability(probabilities.rejects);
    workflow.log(
      reviewer.task_id,
      `ruling ${ruling ?? "unknown"}: rejects=${probabilities.rejects.toFixed(2)}`,
    );
    return ruling;
  } catch (error) {
    workflow.log(
      reviewer.task_id,
      `ruling unknown, decisions failed: ${String(error).slice(0, 200)}`,
    );
    return null;
  }
}

/** Have the agent ask the thread for the ruling the decisions model could not give. */
export async function askPersonToRule(
  workflow: WorkflowRuntime,
  input: { author: TaskRow; artifact: ArtifactRow; entry: JudgeEntry; conclusion: string },
): Promise<void> {
  const { author, artifact, entry, conclusion } = input;
  await markBoardDirty(workflow, author.job_id);
  await workflow.tellAgent(
    noteMessage(
      [
        `The ${entry.name} review of ${artifact.external_url} needs a person's ruling. Code could not tell whether the reviewer rejected or approved the artifact of job ${author.job_id}.`,
        "Ask the thread with ask. Quote what the reviewer concluded, then ask whether the artifact is rejected or approved.",
        "When a person answers, call rule_on_review with their ruling, and with their reason when they reject. Never rule yourself.",
        conclusion
          ? `The reviewer concluded:\n${conclusion}`
          : "The reviewer closed with no conclusion.",
      ].join("\n"),
    ),
    "blocked",
  );
}
