import type { CheckFailure } from "@artfct-ai/adapters/code/types";
import type { ArtifactChecks, ChecksSupport } from "../../artifact/types";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import { promptTask } from "../task/harness/prompt-queue";
import type { WorkflowRuntime } from "../types";
import { taskQuiet } from "./loop";
import { artifactRevision } from "./outcome";

/** How long a revision that no check reported on is held after its submitter went quiet. */
export const CHECKS_GRACE_MS = 5 * 60_000;
/** How long passed checks must stand before the gate opens, so a chained pipeline can start. */
export const CHECKS_QUIET_MS = 60_000;
/** How long the gate holds for checks that still run after their submitter went quiet. */
export const CHECKS_LIMIT_MS = 2 * 3_600_000;
/** How often the checks are read again while the artifact waits on them. */
export const RECHECK_SECONDS = 60;

/** The repeating alarm that reads the checks of a job's artifact again. */
export type ChecksAlarm = { job_id: string };

/** What the host says about the artifact's revision lets the workflow do with it. */
export type ChecksGate =
  | { gate: "open" }
  | { gate: "waiting" }
  | { gate: "sent_back" }
  | { gate: "blocked"; reason: string };

/**
 * Read the checks of the revision a quiet submitter pushed and say what they allow. Failed
 * checks or a conflict with the base branch go back to it once per revision. A revision that
 * went back already, checks a code change cannot fix, and checks that outlast the limit block
 * the artifact. A kind without checks and a host that cannot name the revision leave the gate
 * open. The recheck alarm repeats while the gate holds the artifact.
 */
export async function checksGate(
  workflow: WorkflowRuntime,
  submitter: TaskRow,
  artifact: ArtifactRow,
): Promise<ChecksGate> {
  const gate = await readGate(workflow, submitter, artifact);
  const alarm: ChecksAlarm = { job_id: artifact.job_id };
  if (gate.gate === "waiting" || gate.gate === "sent_back") {
    await workflow.startRepeatingAlarm(RECHECK_SECONDS, "recheckChecks", alarm);
  } else {
    await workflow.stopRepeatingAlarm("recheckChecks", alarm);
  }
  return gate;
}

async function readGate(
  workflow: WorkflowRuntime,
  submitter: TaskRow,
  artifact: ArtifactRow,
): Promise<ChecksGate> {
  const support = workflow.artifact(artifact.kind).checks;
  const revision = support ? await artifactRevision(workflow, artifact) : null;
  if (!support || revision === null) return { gate: "open" };
  const checks = await readChecks(workflow, { support, artifact, revision });
  const quietMs = workflow.now() - Date.parse(lastSeenWorking(workflow, submitter));
  switch (checks.state) {
    case "passed":
      if (workflow.now() - Date.parse(checks.settled_at) < CHECKS_QUIET_MS) {
        return { gate: "waiting" };
      }
      return { gate: "open" };
    case "unreported":
      if (quietMs < CHECKS_GRACE_MS) return { gate: "waiting" };
      workflow.log(submitter.task_id, `no check reported on ${revision}. the artifact moves on.`);
      return { gate: "open" };
    case "merge_unknown":
    case "running":
      if (quietMs < CHECKS_LIMIT_MS) return { gate: "waiting" };
      return {
        gate: "blocked",
        reason: `The checks did not finish within ${CHECKS_LIMIT_MS / 60_000} minutes.`,
      };
    case "failed": {
      const sent = await sendFailedChecksBack(workflow, submitter, artifact, {
        support,
        revision,
        failures: checks.failures,
      });
      return gateAfterSendBack(workflow, submitter, {
        sent,
        reason: `The checks still fail after ${submitter.task_id} answered them: ${namesOf(checks.failures)}.`,
      });
    }
    case "conflicted": {
      const sent = await sendConflictBack(workflow, submitter, artifact, {
        support,
        revision,
        base: checks.base,
      });
      return gateAfterSendBack(workflow, submitter, {
        sent,
        reason: `The artifact still conflicts with ${checks.base} after ${submitter.task_id} answered the conflict.`,
      });
    }
    case "stopped":
      return {
        gate: "blocked",
        reason: `The checks stopped in a way a code change does not fix: ${namesOf(checks.failures)}.`,
      };
    default: {
      const unreachable: never = checks;
      throw new Error(`unhandled checks state ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * A revision went back to its submitter. The gate holds the artifact while the submitter
 * answers, and blocks it when the quiet submitter left the same revision behind.
 */
function gateAfterSendBack(
  workflow: WorkflowRuntime,
  submitter: TaskRow,
  sendBack: { sent: boolean; reason: string },
): ChecksGate {
  if (sendBack.sent) return { gate: "sent_back" };
  if (!taskQuiet(workflow, workflow.store.requireTask(submitter.task_id)))
    return { gate: "waiting" };
  return { gate: "blocked", reason: sendBack.reason };
}

/**
 * When the harness of a task last showed work, which is when its push was at the latest. A
 * model-call task has no sandbox, so its start stands in.
 */
function lastSeenWorking(workflow: WorkflowRuntime, task: TaskRow): string {
  return workflow.store.sandbox(task.task_id)?.last_progress_at ?? task.started_at;
}

/** The failed checks of one revision, and the kind that words them for a task. */
type FailedChecks = { support: ChecksSupport; revision: string; failures: CheckFailure[] };

/**
 * Claim the one send-back a revision gets, for failed checks or a conflict alike. False when
 * the revision went back already.
 */
function claimChecksSendBack(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow,
  revision: string,
): boolean {
  const id = `checks_sent_back:${artifact.job_id}:${revision}`;
  return workflow.store.markEventSeen({ id, kind: "checks_sent_back" });
}

/**
 * Send the failed checks of a revision to its submitter. Each revision goes back once. False
 * when this one already went.
 */
export async function sendFailedChecksBack(
  workflow: WorkflowRuntime,
  submitter: TaskRow,
  artifact: ArtifactRow,
  failed: FailedChecks,
): Promise<boolean> {
  if (!claimChecksSendBack(workflow, artifact, failed.revision)) return false;
  workflow.log(
    submitter.task_id,
    `the checks failed on ${failed.revision}: ${namesOf(failed.failures)}`,
  );
  await promptTask(
    workflow,
    submitter,
    failed.support.failurePrompt(artifact.ref, failed.failures),
  );
  return true;
}

/** A revision that conflicts with its base branch, and the kind that words it for a task. */
type Conflict = { support: ChecksSupport; revision: string; base: string };

/**
 * Send the conflict of a revision with its base branch to its submitter. Each revision goes
 * back once. False when this one already went.
 */
export async function sendConflictBack(
  workflow: WorkflowRuntime,
  submitter: TaskRow,
  artifact: ArtifactRow,
  conflict: Conflict,
): Promise<boolean> {
  if (!claimChecksSendBack(workflow, artifact, conflict.revision)) return false;
  workflow.log(submitter.task_id, `${conflict.revision} conflicts with ${conflict.base}`);
  await promptTask(
    workflow,
    submitter,
    conflict.support.conflictPrompt(artifact.ref, conflict.base),
  );
  return true;
}

/** Checks the host would not give read as running, so the wait ends at the limit. */
async function readChecks(
  workflow: WorkflowRuntime,
  input: { support: ChecksSupport; artifact: ArtifactRow; revision: string },
): Promise<ArtifactChecks> {
  const { support, artifact, revision } = input;
  return support.read(artifact.ref, revision).catch((error: unknown): ArtifactChecks => {
    workflow.log(
      null,
      `checks of job ${artifact.job_id} could not be read: ${String(error).slice(0, 200)}`,
    );
    return { state: "running" };
  });
}

function namesOf(failures: CheckFailure[]): string {
  return failures.map((failure) => `${failure.name} (${failure.conclusion})`).join(", ");
}
