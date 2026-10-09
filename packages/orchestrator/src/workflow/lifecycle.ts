import type { Harness } from "@artfct-ai/adapters/harness/types";
import type { Binding, BindingSource } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import type { ArtifactClose, ArtifactTarget } from "../artifact/types";
import { branchName, jobId as makeJobId, newToken, taskId as makeTaskId } from "../ids";
import { resolveStage, type ResolvedStage } from "../config/stage";
import { noteMessage } from "../agent/transcript/envelope";
import { bindWorkflow as bindInDb, deleteBindings } from "../db/bindings";
import { createDb } from "../db/client";
import { setWorkflowStatus } from "../db/workflows";
import { dropBoardFlush, flushBoards } from "./board/board";
import { onReviewerFailed } from "./refiner/loop";
import { endPolisherRun } from "./refiner/polish";
import { refinerRunOf } from "./refiner/stage-refiner";
import { markArtifactReady } from "./refiner/outcome";
import type { WorkflowRuntime } from "./types";
import type { JobRow, NewTask, TaskRow } from "./store/tasks";
import { jobInputKey } from "./store/input-key";
import { isTaskFinished } from "./store/state";
import {
  MAX_SANDBOX_RESTARTS,
  clearTaskTimers,
  closeContainer,
  destroySandbox,
  restartSandbox,
} from "./task/sandbox/sandbox";

/** The tracker issue a job works on, as resolved by the start_job guard. */
export type JobIssue = {
  id: string;
  key: string;
  title: string;
  team_id: string | null;
  /** True when the issue is already in a started state, so the claim leaves its state alone. */
  started: boolean;
};

/**
 * What a job works from: a tracker issue, an artifact the request points at that no job of this
 * workflow produced, the artifact of the completed job it builds on, or an ad hoc request. The
 * request text is the text of the prompts that woke the agent turn.
 */
export type JobInput =
  | { kind: "issue"; issue: JobIssue }
  | { kind: "target"; target: ArtifactTarget }
  | { kind: "artifact"; jobId: string }
  | { kind: "request"; text: string };

/** What the agent hands over when it starts a job. A field set here beats the stage config. */
export type StartJobOptions = {
  /** A stage name from the config. The plan is a guide, so any configured stage may run. */
  stage: string;
  brief: string;
  input: JobInput;
  /** The branch of the input artifact, for a job that continues it. Any other job gets its own. */
  continued_branch?: string;
  title?: string;
  harness?: Harness;
  model?: string;
};

/**
 * Create a job for the named stage with its first task, and schedule provisioning.
 */
export async function startJob(
  workflow: WorkflowRuntime,
  options: StartJobOptions,
): Promise<JobRow | null> {
  const { state } = workflow;
  const stageDefinition = workflow
    .workflowDefinition()
    .stages.find((stage) => stage.name === options.stage);
  if (!stageDefinition) {
    workflow.log(
      null,
      `start_job refused: stage ${options.stage} is not in the workflow definition`,
    );
    return null;
  }
  const stage = resolveStage(workflow.config(), stageDefinition);
  const jobSequence = (state.job_seq ?? 0) + 1;
  const jobId = makeJobId(state.workflow_id, jobSequence);
  const { input } = options;
  const issue = input.kind === "issue" ? input.issue : null;
  const target = input.kind === "target" ? input.target : null;
  const title = issue?.title ?? options.title ?? state.request.title;
  const branch = stage.branch ? (options.continued_branch ?? branchName(jobId, title)) : null;
  workflow.store.insertJob({
    job_id: jobId,
    stage: stage.name,
    issue_id: issue?.id ?? null,
    issue_key: issue?.key ?? null,
    input_key: jobInputKey(input),
    preceding_job_id: input.kind === "artifact" ? input.jobId : null,
    input_ref: target?.ref ?? null,
    input_url: target?.url ?? null,
    branch,
    brief: options.brief,
    author_harness: options.harness ?? null,
    author_model: options.model ?? null,
  });
  workflow.patchState({ job_seq: jobSequence });
  const job = workflow.store.requireJob(jobId);
  const taskId = insertJobTask(
    workflow,
    stage.research
      ? {
          job_id: jobId,
          role: "researcher",
          harness: stage.research.harness,
          model: stage.research.model,
        }
      : authorTaskOf(stage, job),
  );
  await changeWorkflowStatus(workflow, "running");
  if (issue) {
    await bindWorkflow(workflow, { source: "tracker_issue", external_id: issue.id });
    const ref = { issue_id: issue.id, team_id: issue.team_id };
    await workflow.notifier.claimIssue(ref, { started: issue.started });
    const { origin } = state;
    if (origin?.source === "chat") await workflow.notifier.linkChatThread(ref, origin);
  }
  if (branch && state.repo) {
    await bindWorkflow(workflow, { source: "code_branch", repo: state.repo.full, branch });
  }
  await workflow.post({ type: "started", stage: stage.name, job_id: jobId });
  await flushBoards(workflow, jobId);
  await workflow.scheduleAlarm(0, "provision", { task_id: taskId });
  return job;
}

/** The author task of a job, on the harness and model the agent chose at start, else the produce activity's. */
function authorTaskOf(stage: ResolvedStage, job: JobRow): JobTask {
  const { produce } = stage.author;
  return {
    job_id: job.job_id,
    role: "author",
    harness: produce.execution === "model" ? null : (job.author_harness ?? produce.harness),
    model: job.author_model ?? produce.model,
  };
}

/** The next task of a job. A null harness makes it a model-call task. */
type JobTask = Pick<NewTask, "job_id" | "model"> & {
  role: "author" | "researcher";
  harness: Harness | null;
};

/** Insert the next task of a job under a fresh task id, and return that id. */
function insertJobTask(workflow: WorkflowRuntime, task: JobTask): string {
  const taskSequence = workflow.state.task_seq + 1;
  const taskId = makeTaskId(workflow.state.workflow_id, taskSequence);
  const { harness, ...fields } = task;
  const sandbox = harness === null ? null : { harness, bridge_token: newToken() };
  workflow.store.insertTask({ ...fields, task_id: taskId, sandbox });
  workflow.patchState({ task_seq: taskSequence });
  return taskId;
}

/** Handle handoff from researcher to author */
export async function startAuthorAfterResearch(
  workflow: WorkflowRuntime,
  researcher: TaskRow,
  payload: string,
): Promise<void> {
  workflow.store.updateJobResearchPayload(researcher.job_id, payload);
  workflow.log(researcher.task_id, `research payload stored (${payload.length} chars)`);
  await finishTask(workflow, researcher, "done");
  await dropBoardFlush(workflow, researcher.task_id);
  const job = workflow.store.requireJob(researcher.job_id);
  const authorId = insertJobTask(workflow, authorTaskOf(workflow.stageFor(job), job));
  await flushBoards(workflow, researcher.job_id);
  await workflow.scheduleAlarm(0, "provision", { task_id: authorId });
}

/** What is left after a job completed: the author tasks still active and the free slots. */
export type CompleteOutcome = { running: number; slots: number };

/** The teardown every end of a task shares. The status is written before the sandbox goes. */
async function finishTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  status: "done" | "cancelled" | "failed",
): Promise<void> {
  workflow.store.updateTask(task.task_id, { status });
  const sandbox = workflow.store.sandbox(task.task_id);
  if (!sandbox) {
    workflow.store.clearPromptQueue(task.task_id);
    return;
  }
  await clearTaskTimers(workflow, sandbox);
  await destroySandbox(workflow, task);
}

/**
 * An author task is over and the review of its job with it. The humans get the artifact the
 * review was holding, and the board says so.
 */
async function endReviewAndBoard(
  workflow: WorkflowRuntime,
  jobId: string,
  options: { reason: string; close: ArtifactClose },
): Promise<void> {
  await cancelRefinerRunOf(workflow, jobId, options.reason);
  await markArtifactReady(workflow, jobId, options.close);
  await flushBoards(workflow, jobId);
}

/** The agent judged the job done. Tear its author task down and say how many slots are left. */
export async function completeJob(
  workflow: WorkflowRuntime,
  author: TaskRow,
  result: string,
): Promise<CompleteOutcome> {
  workflow.log(author.task_id, `done: ${result}`);
  await finishTask(workflow, author, "done");
  await endReviewAndBoard(workflow, author.job_id, {
    reason: "the job is complete",
    close: { close: "ready" },
  });
  const running = workflow.store.activeAuthorAndResearcherTasks().length;
  return { running, slots: Math.max(0, workflow.state.concurrency - running) };
}

/** The agent says the work is complete. The channels hear the result. Each session's issue completes. */
export async function completeWorkflow(workflow: WorkflowRuntime, result: string): Promise<void> {
  await changeWorkflowStatus(workflow, "done");
  workflow.log(null, `finished: ${result}`);
  await workflow.post({ type: "done", result });
  for (const target of workflow.state.reply_targets) {
    if (target.source === "tracker") await workflow.notifier.moveIssue(target, "completed");
  }
  await unbindCodeHost(workflow);
}

/**
 * Stop the task without failing the workflow. Used for a closed artifact and for cancel. An
 * author or researcher task takes its job down with it: the refiner run, the review, and the board.
 */
export async function cancelTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  if (isTaskFinished(task.status)) return;
  workflow.log(task.task_id, `cancelled: ${reason}`);
  await finishTask(workflow, task, "cancelled");
  switch (task.role) {
    case "polisher":
      return endPolisherRun(workflow, task, {
        ended: "stopped",
        reason: `the polisher was cancelled: ${reason}`,
      });
    case "reviewer":
      return;
    case "author":
    case "researcher":
      break;
  }
  await endReviewAndBoard(workflow, task.job_id, {
    reason,
    close: {
      close: "blocked",
      reason: `The job was cancelled before the review settled (${reason}).`,
    },
  });
  await workflow.tellAgent(noteMessage(`Job ${task.job_id} was cancelled: ${reason}`), "none");
}

/** The review of the job is over. The refiner run on its artifact has nothing left to work on. */
export async function cancelRefinerRunOf(
  workflow: WorkflowRuntime,
  jobId: string,
  reason: string,
): Promise<void> {
  const artifact = workflow.store.artifact(jobId);
  const run = artifact ? refinerRunOf(workflow, artifact) : null;
  workflow.store.setArtifactRefinerRun(jobId, null);
  if (run) await cancelTask(workflow, run, reason);
}

/**
 * Fail one task: tear its sandbox down and wake the agent. A failed refiner run gives its artifact to
 * the humans instead.
 */
export async function failTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  if (isTaskFinished(task.status)) return;
  workflow.log(task.task_id, `failed: ${reason}`);
  await finishTask(workflow, task, "failed");
  switch (task.role) {
    case "polisher":
      return endPolisherRun(workflow, task, { ended: "stopped", reason });
    case "reviewer":
      return onReviewerFailed(workflow, task, reason);
    case "author":
    case "researcher":
      break;
  }
  await endReviewAndBoard(workflow, task.job_id, {
    reason,
    close: { close: "blocked", reason: `The job failed before the review settled (${reason}).` },
  });
  await workflow.post({ type: "failed", job_id: task.job_id, reason });
  await workflow.tellAgent(
    noteMessage(
      `Job ${task.job_id} failed: its ${task.role} ${task.task_id} stopped (${reason}). Retry its work with start_job, or call fail_workflow.`,
    ),
    "task_result",
  );
}

/**
 * A task with a sandbox hit a failure it may recover from. It restarts in a fresh sandbox on its
 * branch while it has restarts left, and fails after that.
 */
export async function restartOrFailTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  if (isTaskFinished(task.status)) return;
  if (workflow.store.requireSandbox(task.task_id).restarts >= MAX_SANDBOX_RESTARTS) {
    return failTask(workflow, task, reason);
  }
  workflow.log(task.task_id, `${reason} restarting in a fresh sandbox.`);
  await closeContainer(workflow, task, "the task restarts");
  workflow.store.patchTodoRow(task.task_id, { note: `Restarted in a fresh sandbox: ${reason}` });
  await restartSandbox(workflow, task);
  await flushBoards(workflow, task.job_id);
  await workflow.tellAgent(
    noteMessage(
      `The ${task.role} ${task.task_id} of job ${task.job_id} restarted in a fresh sandbox on its branch (${reason}).`,
    ),
    "none",
  );
}

/**
 * Fail the workflow: cancel every active task and post the reason. The chat and issue
 * bindings stay, so a later start on them begins a new workflow.
 */
export async function failWorkflow(workflow: WorkflowRuntime, reason: string): Promise<void> {
  for (const task of workflow.store.activeAuthorAndResearcherTasks()) {
    await cancelTask(workflow, task, reason);
  }
  for (const task of workflow.store.activeRefinerRuns()) await cancelTask(workflow, task, reason);
  await changeWorkflowStatus(workflow, "failed");
  await workflow.post({ type: "workflow_failed", reason });
  await unbindCodeHost(workflow);
}

/** Point an external object (pull, branch, page) at this workflow so ingress can route to it. */
export async function bindWorkflow(workflow: WorkflowRuntime, binding: Binding): Promise<void> {
  const db = createDb(workflow.env.DB);
  await bindInDb(db, binding, workflow.state.workflow_id);
}

/**
 * Move the workflow to a new status. The only writer of the status: the router reads the D1 copy
 * to drop machine events on a finished workflow without waking it.
 */
export async function changeWorkflowStatus(
  workflow: WorkflowRuntime,
  status: WorkflowStatus,
): Promise<void> {
  if (workflow.state.status === status) return;
  workflow.patchState({ status });
  const db = createDb(workflow.env.DB);
  await setWorkflowStatus(db, workflow.state.workflow_id, status);
}

/** The bindings a workflow takes on the code host: its branches and its pull requests. */
const CODE_SOURCES: BindingSource[] = ["code_branch", "code_pull"];

/**
 * The workflow ended, whichever way, so its code host bindings go. The chat, tracker session, and
 * issue bindings stay, so a later start on them begins a new workflow.
 */
export async function unbindCodeHost(workflow: WorkflowRuntime): Promise<void> {
  const db = createDb(workflow.env.DB);
  await deleteBindings(db, workflow.state.workflow_id, CODE_SOURCES);
}

/** What the agent says when the humans have been silent for `orchestrator.idle_hours`. */
const SLEEP_TEXT =
  "I have not heard back, so I am going to sleep for now. Tag me here to continue.";

/** Task statuses in which a harness is at work, so the workflow is not waiting on a human. */
const BUSY = new Set(["queued", "provisioning", "working"]);

/** Start the idle clock over. One alarm at a time: the previous one is cancelled first. */
export async function armIdle(workflow: WorkflowRuntime): Promise<void> {
  const hours = workflow.config().orchestrator.idle_hours;
  if (workflow.state.idle_alarm) await workflow.cancelAlarm(workflow.state.idle_alarm);
  if (!hours) return;
  const id = await workflow.scheduleAlarm(hours * 3600, "onIdle", {});
  workflow.patchState({ idle_alarm: id });
}

/** The idle clock ran out. With no harness at work, tell the channels the workflow sleeps. */
export async function onIdle(workflow: WorkflowRuntime): Promise<void> {
  workflow.patchState({ idle_alarm: null });
  if (workflow.store.activeAuthorAndResearcherTasks().some((task) => BUSY.has(task.status))) return;
  if (workflow.state.status !== "running" && workflow.state.status !== "planning") return;
  workflow.log(null, "idle. going to sleep.");
  await changeWorkflowStatus(workflow, "waiting_input");
  await workflow.post({ type: "info", text: SLEEP_TEXT });
}
