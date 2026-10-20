import type { Artifact, ArtifactRef, ArtifactTarget } from "../artifact/types";
import type { ResolvedStage } from "../config/stage";
import { bindWorkflow } from "./lifecycle";
import { flushBoards } from "./board/board";
import { markArtifactReady } from "./refiner/outcome";
import { refinerCount } from "./refiner/stage-refiner";
import { isTaskFinished } from "./store/state";
import type { TaskRow } from "./store/tasks";
import type { WorkflowRuntime } from "./types";
import { setWorkflowSubject, subjectOfRef, validateOutputIsSubject } from "./subject";

/**
 * Record the artifact a link in the author's output names. True when the job has an artifact
 * after this. A finished task reads nothing: its harness can still be mid-send while the cancel
 * tears the container down, and what it says then is about work nobody asked for any more. A
 * kind whose artifact ends the turn waits for the turn end.
 */
export async function detectArtifact(
  workflow: WorkflowRuntime,
  task: TaskRow,
  text: string,
): Promise<boolean> {
  const find = async (kind: Artifact) => (kind.endsTurn ? null : kind.detect(text));
  return recordFoundArtifact(workflow, task, find, () => {});
}

/**
 * Record the artifact the author's turn text names, else the one the host holds open on the
 * job's branch. The branch lookup is a host call, so it runs once per turn and not per chunk.
 * An output that is not the subject is not recorded, and the author's next prompt says why.
 */
export async function detectArtifactAfterTurn(
  workflow: WorkflowRuntime,
  task: TaskRow,
  turnText: string,
): Promise<boolean> {
  const { branch } = workflow.store.requireJob(task.job_id);
  const find = async (kind: Artifact) => {
    const printed = await kind.detect(turnText);
    if (printed || !branch || !kind.openOnBranch) return printed;
    return kind.openOnBranch(branch);
  };
  return recordFoundArtifact(workflow, task, find, (reason) => {
    workflow.log(task.task_id, `output not recorded: it is not the subject`);
    workflow.store.enqueuePrompt(task.task_id, reason);
  });
}

async function recordFoundArtifact(
  workflow: WorkflowRuntime,
  task: TaskRow,
  find: (kind: Artifact) => Promise<ArtifactTarget | null>,
  refuse: (reason: string) => void,
): Promise<boolean> {
  if (task.role !== "author" || isTaskFinished(task.status)) return false;
  if (workflow.store.artifact(task.job_id)) return true;
  const kind = workflow.artifact(workflow.stageForTask(task).artifact);
  const found = await find(kind).catch((error: unknown) => {
    workflow.log(task.task_id, `artifact lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  });
  if (!found) return false;
  const { ref } = found;
  const isTrackerRef = ref.kind === "issue" || ref.kind === "project";
  const offSubject = isTrackerRef ? await validateOutputIsSubject(workflow, ref) : null;
  if (offSubject) {
    refuse(offSubject);
    return false;
  }
  await recordArtifact(workflow, task, found);
  return true;
}

/**
 * True when a job of this stage that is given this artifact as its input continues it: the
 * stage works on a branch and produces that kind. Such a job works on the artifact's branch.
 */
export function stageContinuesArtifact(stage: ResolvedStage, ref: ArtifactRef | null): boolean {
  return stage.branch && stage.artifact === ref?.kind;
}

/** True when a refiner runs over this stage's artifact before the humans do. */
export function stageHasRefiners(stage: ResolvedStage): boolean {
  return refinerCount(stage) > 0;
}

/**
 * An unfinished author whose job has an artifact, with no prompt in flight and no handshake
 * pending, is idle with its artifact out, so it is `in_review`. Mid-turn it stays `working` until its
 * turn ends. A model-call author has no prompt in flight once its model call returned.
 */
export function markAuthorInReview(workflow: WorkflowRuntime, taskId: string): void {
  const task = workflow.store.requireTask(taskId);
  if (task.status !== "working" && task.status !== "queued") return;
  if (!workflow.store.artifact(task.job_id)) return;
  if (workflow.store.sandbox(taskId)?.prompt_in_flight) return;
  if (workflow.store.handshakePending(taskId)) return;
  workflow.store.updateTask(taskId, { status: "in_review" });
}

/**
 * Store the artifact of the author's job and bind it for routing. A stage that declares refiners
 * keeps it a draft until they settle. Anything else goes to the humans now. The host can open an
 * artifact for an author that is already over, so the row is stored and bound either way.
 */
export async function recordArtifact(
  workflow: WorkflowRuntime,
  task: TaskRow,
  target: ArtifactTarget,
): Promise<void> {
  const kind = workflow.stageForTask(task).artifact;
  workflow.store.upsertArtifact({
    job_id: task.job_id,
    kind,
    external_url: target.url,
    ref: target.ref,
  });
  markAuthorInReview(workflow, task.task_id);
  const { ref } = target;
  if ((ref.kind === "issue" || ref.kind === "project") && !workflow.store.subject()) {
    await setWorkflowSubject(workflow, subjectOfRef(ref));
  }
  const binding = workflow.artifact(kind).binding(target.ref);
  if (binding) await bindWorkflow(workflow, binding);
  workflow.log(task.task_id, `artifact ${kind} ${target.url}`);
  workflow.store.completeTodos(task.task_id);
  await flushBoards(workflow, task.job_id);
  if (stageHasRefiners(workflow.stageForTask(task))) {
    workflow.log(task.task_id, "holding the announcement until the review settles");
    return;
  }
  await markArtifactReady(workflow, task.job_id, { close: "ready" });
}
