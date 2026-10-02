import { noteMessage } from "../../agent/transcript/envelope";
import { isTaskFinished, isWorkflowFinished } from "../store/state";
import { runningPolisherOf } from "./stage-refiner";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";
import {
  RECHECK_SECONDS,
  sendConflictBack,
  sendFailedChecksBack,
  type ChecksAlarm,
} from "./checks-gate";
import { refinerInFlight, settleRefinersForAuthor, taskQuiet } from "./loop";
import { artifactRevision } from "./outcome";
import { settlePolisherTurn } from "./polish";

/**
 * Alarm: read the checks of a job's artifact again. The gate stops the alarm once it opens or
 * blocks. An artifact the host closed, or a finished workflow, stops it here.
 */
export async function recheckChecks(workflow: WorkflowRuntime, alarm: ChecksAlarm): Promise<void> {
  const status = workflow.store.artifact(alarm.job_id)?.status;
  const open = status === "drafted" || status === "ready";
  if (!open || isWorkflowFinished(workflow.state.status)) {
    return workflow.stopRepeatingAlarm("recheckChecks", alarm);
  }
  await settleChecks(workflow, alarm.job_id);
}

/**
 * The host may say something new about a job's artifact. The task that pushed the revision
 * settles: a polisher that holds the artifact, else the author. A task at work settles when
 * its turn ends. The gate does not run while the humans hold the artifact or a reviewer reads
 * it, so the author hears of it as a follow-up.
 */
export async function settleChecks(workflow: WorkflowRuntime, jobId: string): Promise<void> {
  const polisher = runningPolisherOf(workflow, jobId);
  if (polisher) {
    if (taskQuiet(workflow, polisher)) await settlePolisherTurn(workflow, polisher);
    return;
  }
  const author = workflow.store.authorTask(jobId);
  const artifact = workflow.store.artifact(jobId);
  if (!author || !artifact) return;
  if (artifact.status === "ready" || refinerInFlight(workflow, jobId)) {
    return followUpWithIdleAuthor(workflow, author, artifact);
  }
  await settleRefinersForAuthor(workflow, author);
}

/**
 * Failed checks and a conflict with the base branch go to the idle author once per revision.
 * The agent hears of a conflict that a finished author cannot take.
 * The recheck alarm repeats while the host has not worked the merge out.
 */
async function followUpWithIdleAuthor(
  workflow: WorkflowRuntime,
  author: TaskRow,
  artifact: ArtifactRow,
): Promise<void> {
  const support = workflow.artifact(artifact.kind).checks;
  if (!support || !taskQuiet(workflow, author)) return;
  const revision = await artifactRevision(workflow, artifact);
  if (revision === null) return;
  const checks = await support.read(artifact.ref, revision).catch((error: unknown) => {
    workflow.log(author.task_id, `checks could not be read: ${String(error).slice(0, 200)}`);
    return null;
  });
  const alarm: ChecksAlarm = { job_id: artifact.job_id };
  if (checks?.state === "merge_unknown") {
    return workflow.startRepeatingAlarm(RECHECK_SECONDS, "recheckChecks", alarm);
  }
  await workflow.stopRepeatingAlarm("recheckChecks", alarm);
  if (checks?.state === "failed") {
    await sendFailedChecksBack(workflow, author, artifact, {
      support,
      revision,
      failures: checks.failures,
    });
  }
  if (checks?.state !== "conflicted") return;
  const conflict = { support, revision, base: checks.base };
  const claimed = await sendConflictBack(workflow, author, artifact, conflict);
  if (!claimed || !isTaskFinished(author.status)) return;
  await workflow.tellAgent(
    noteMessage(
      `${artifact.external_url} of job ${artifact.job_id} conflicts with its base branch ${checks.base}. Its author ${author.task_id} is ${author.status}, so nobody was sent the conflict. Tell the humans.`,
    ),
    "external_state",
  );
}
