import { drainQueue } from "../task/harness/prompt-queue";
import { checksGate, type ChecksGate } from "./checks-gate";
import { finishTask } from "../lifecycle";
import { advanceArtifactPastEntry } from "./loop";
import { handOverArtifactAt, revisionOfTheJobsArtifact } from "./outcome";
import { refinerIndexOf, refinerAt, runningPolisherOf } from "./stage-refiner";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/**
 * How a polisher run ended: its turn finished, something stopped it partway, or the checks of
 * what it pushed block the artifact.
 */
export type PolishOutcome =
  | { ended: "turn" }
  | { ended: "stopped"; reason: string }
  | { ended: "blocked"; reason: string };

/**
 * A polisher went quiet. Its run ends once the checks of the revision it left passed. Failed
 * checks go back to it, and it stays the holder of the artifact while it answers them.
 */
export async function settlePolisherTurn(
  workflow: WorkflowRuntime,
  polisher: TaskRow,
): Promise<void> {
  const artifact = workflow.store.artifact(polisher.job_id);
  const holds = artifact?.refiner_task_id === polisher.task_id && artifact.status === "drafted";
  const gate = holds ? await checksGate(workflow, polisher, artifact) : OPEN_GATE;
  switch (gate.gate) {
    case "open":
      return endPolisherRun(workflow, polisher, { ended: "turn" });
    case "blocked":
      return endPolisherRun(workflow, polisher, { ended: "blocked", reason: gate.reason });
    case "waiting":
    case "sent_back":
      await drainQueue(workflow, workflow.store.requireTask(polisher.task_id));
      return;
    default: {
      const unreachable: never = gate;
      throw new Error(`unhandled checks gate ${JSON.stringify(unreachable)}`);
    }
  }
}

const OPEN_GATE: ChecksGate = { gate: "open" };

/**
 * End a polisher run, whatever ended it. The revision is read before the run ends. A refiner
 * that still holds the artifact hands it on, and a stopped one ends the lists and gives it to
 * the humans with the reason. The author's queue drains next on every path, including the one
 * where the artifact no longer points at the polisher, because the author took no prompt while
 * the polisher held its artifact. The polisher's sandbox goes last.
 */
export async function endPolisherRun(
  workflow: WorkflowRuntime,
  polisher: TaskRow,
  outcome: PolishOutcome,
): Promise<void> {
  const revision = await revisionOfTheJobsArtifact(workflow, polisher.job_id);
  await finishTask(workflow, polisher, async () => {
    const author = workflow.store.authorTaskOf(polisher.job_id);
    await handOnFromPolisher(workflow, { author, polisher, outcome, revision });
    await drainQueue(workflow, workflow.store.requireTask(author.task_id));
  });
}

/** Where the artifact goes now that this polisher is over. */
async function handOnFromPolisher(
  workflow: WorkflowRuntime,
  ended: { author: TaskRow; polisher: TaskRow; outcome: PolishOutcome; revision: string | null },
): Promise<void> {
  const { author, polisher, outcome, revision } = ended;
  const artifact = workflow.store.artifact(author.job_id);
  if (!artifact || artifact.refiner_task_id !== polisher.task_id) {
    workflow.log(author.task_id, "polish dropped: the artifact no longer holds this polisher");
    return;
  }
  if (outcome.ended === "blocked") {
    const close = { close: "blocked" as const, reason: outcome.reason };
    await handOverArtifactAt(workflow, author.job_id, { close, revision });
    return;
  }
  if (outcome.ended === "stopped") {
    const reason = `The polish stopped early (${outcome.reason}). The branch may hold part of its changes.`;
    await handOverArtifactAt(workflow, author.job_id, {
      close: { close: "blocked", reason },
      revision,
    });
    return;
  }
  if (artifact.status !== "drafted") {
    workflow.log(author.task_id, `polish dropped: the artifact is already ${artifact.status}`);
    return;
  }
  await advanceArtifactPastEntry(workflow, author, refinerIndexOf(polisher), revision);
}

/**
 * The refusal the agent gets while a polisher holds the artifact of the author's job, naming the entry
 * that runs. Null when no polisher holds it.
 */
export function polisherRefusal(workflow: WorkflowRuntime, author: TaskRow): string | null {
  const polisher = runningPolisherOf(workflow, author.job_id);
  if (!polisher) return null;
  const name =
    refinerAt(workflow.stageForTask(author), refinerIndexOf(polisher))?.entry.name ?? "a polisher";
  return `${name} is changing the artifact of job ${author.job_id} right now. Nothing routes until it ends.`;
}
