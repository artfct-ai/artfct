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
import { TAG_TO_START_AGAIN } from "../notify/messages";
import { dropBoardFlush, flushBoards } from "./board/board";
import { closeAbandonedTurnFeed, STOPPED_CLOSING } from "./feed/feed";
import { onReviewerFailed } from "./refiner/loop";
import { endPolisherRun } from "./refiner/polish";
import { refinerRunOf } from "./refiner/stage-refiner";
import { markArtifactReady } from "./refiner/outcome";
import type { WorkflowRuntime } from "./types";
import type { JobRow, NewTask, TaskRow } from "./store/tasks";
import { jobInputKey } from "./store/input-key";
import { isTaskFinished, isWorkflowFinished, type WorkflowEnd } from "./store/state";
import {
  clearTaskTimers,
  closeContainer,
  destroySandbox,
  startSandbox,
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
 * Create a job for the named stage with its first task, and schedule provisioning before the
 * router writes, so a failed one does not strand the task.
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
  const issueLinked = issue !== null && workflow.store.jobByIssue(issue.id) !== null;
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
  await workflow.scheduleAlarm(0, "provision", { task_id: taskId });
  await changeWorkflowStatus(workflow, "running");
  if (issue) {
    const ref = { issue_id: issue.id, team_id: issue.team_id };
    await workflow.notifier.claimIssue(ref, { started: issue.started });
    const { origin, subject } = state;
    const syncedAsSubject = subject?.kind === "issue" && subject.issue_id === issue.id;
    if (origin?.source === "chat" && !issueLinked && !syncedAsSubject) {
      await workflow.notifier.linkChatThread(ref, origin);
    }
  }
  if (branch && state.repo) {
    await bindWorkflow(workflow, { source: "code_branch", repo: state.repo.full, branch });
  }
  await workflow.post({ type: "started", stage: stage.name, job_id: jobId });
  await flushBoards(workflow, jobId);
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
  workflow.store.completeTodos(researcher.task_id);
  await dropBoardFlush(workflow, researcher.task_id);
  const job = workflow.store.requireJob(researcher.job_id);
  const authorId = insertJobTask(workflow, authorTaskOf(workflow.stageFor(job), job));
  await flushBoards(workflow, researcher.job_id);
  await workflow.scheduleAlarm(0, "provision", { task_id: authorId });
}

/** What is left after a job completed: the author tasks still active and the free slots. */
export type CompleteOutcome = { running: number; slots: number };

/**
 * The teardown every end of a task shares. The status is written before the sandbox goes, and
 * with it the model turn of a model-call task ends. False when the task had already finished.
 */
async function finishTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  status: "done" | "cancelled" | "failed",
): Promise<boolean> {
  if (isTaskFinished(workflow.store.requireTask(task.task_id).status)) return false;
  workflow.store.updateTask(task.task_id, { status, model_turn_id: null });
  const sandbox = workflow.store.sandbox(task.task_id);
  if (!sandbox) {
    workflow.store.clearPromptQueue(task.task_id);
    return true;
  }
  await clearTaskTimers(workflow, sandbox);
  await destroySandbox(workflow, task);
  return true;
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

/**
 * The work is complete. Any task still running ends with it. The channels hear the result. Each
 * session's issue completes.
 */
export async function completeWorkflow(workflow: WorkflowRuntime, result: string): Promise<void> {
  await endWorkflow(workflow, { status: "done", reason: result, answering: [] });
}

/**
 * Stop the task without failing the workflow. Used for a closed artifact and for cancel. An
 * author or researcher task takes its job down with it: the refiner run, the review, and the board.
 * The task is cancelled before the feed close returns, so a restart cannot keep the closing alone.
 */
export async function cancelTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  if (isTaskFinished(workflow.store.requireTask(task.task_id).status)) return;
  workflow.log(task.task_id, `cancelled: ${reason}`);
  const [, finished] = await Promise.all([
    closeAbandonedTurnFeed(workflow, task, STOPPED_CLOSING),
    finishTask(workflow, task, "cancelled"),
  ]);
  if (!finished) return;
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
  if (isTaskFinished(workflow.store.requireTask(task.task_id).status)) return;
  workflow.log(task.task_id, `failed: ${reason}`);
  await closeAbandonedTurnFeed(workflow, task, {
    kind: "error",
    text: `The task failed: ${reason}`,
  });
  if (!(await finishTask(workflow, task, "failed"))) return;
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

/** How often a task restarts, whatever the cause, before it fails. */
export const MAX_RESTARTS = 2;

/**
 * A task with a sandbox hit a failure it may recover from. It restarts in a fresh sandbox on its
 * branch while it has restarts left, and fails after that. The restart is written before the old
 * container goes, so a restart of the Durable Object during the destroy leaves the task queued for
 * the start step to provision. A paused task waits queued for its resume. A queued task already
 * has its restart written and is left to it. A task that finished while its old container went
 * stays finished. One that another restart counted or that began a newer generation meanwhile is
 * left to that restart.
 */
export async function restartOrFailTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  const current = workflow.store.requireTask(task.task_id);
  if (isTaskFinished(current.status) || current.status === "queued") return;
  if (current.restarts >= MAX_RESTARTS) return failTask(workflow, task, reason);
  workflow.log(task.task_id, `${reason} restarting in a fresh sandbox.`);
  const restarts = current.restarts + 1;
  workflow.store.updateTask(task.task_id, { status: "queued", restarts });
  workflow.store.patchTodoRow(task.task_id, { note: `Restarted in a fresh sandbox: ${reason}` });
  await workflow.tellAgent(
    noteMessage(
      `The ${task.role} ${task.task_id} of job ${task.job_id} restarted in a fresh sandbox on its branch (${reason}).`,
    ),
    "none",
  );
  const { generation } = workflow.store.requireSandbox(task.task_id);
  await closeContainer(workflow, task, "the task restarts");
  const closed = workflow.store.requireTask(task.task_id);
  if (isTaskFinished(closed.status) || closed.restarts !== restarts) return;
  const sandbox = workflow.store.requireSandbox(task.task_id);
  if (sandbox.generation !== generation) return;
  if (closed.paused_at === null) await startSandbox(workflow, closed, true);
  else await clearTaskTimers(workflow, sandbox);
  await flushBoards(workflow, task.job_id);
}

/**
 * Fail the workflow: cancel every active task and post the reason. The chat and issue
 * bindings stay, so a person's next message on them starts a new workflow.
 */
export async function failWorkflow(workflow: WorkflowRuntime, reason: string): Promise<void> {
  await endWorkflow(workflow, { status: "failed", reason, answering: [] });
}

/** True from the request of a workflow end until the channels heard it. */
export function workflowEnding(workflow: WorkflowRuntime): boolean {
  return (workflow.state.workflow_end ?? null) !== null;
}

/**
 * Record the workflow end in the workflow state before its first cancel, then go on with it. False when the workflow
 * already ended or another end runs, so the caller says nothing.
 */
export async function endWorkflow(workflow: WorkflowRuntime, end: WorkflowEnd): Promise<boolean> {
  if (workflowEnding(workflow) || isWorkflowFinished(workflow.state.status)) return false;
  workflow.patchState({ workflow_end: end });
  await goOnWithWorkflowEnd(workflow, end);
  return true;
}

/**
 * Start step: arm the alarm that goes on with the workflow end the workflow state holds. A later restart
 * before it fires leaves the one alarm armed.
 */
export async function armWorkflowEndAlarm(workflow: WorkflowRuntime): Promise<void> {
  if (!workflowEnding(workflow)) return;
  await workflow.scheduleAlarmOnce("resumeWorkflowEnd", {});
}

/** Alarm: go on with the workflow end that an instance restart cut off. */
export async function resumeWorkflowEnd(workflow: WorkflowRuntime): Promise<void> {
  const end = workflow.state.workflow_end;
  if (end) await goOnWithWorkflowEnd(workflow, end);
}

/**
 * Cancel every active task, author and researcher tasks first, then set the final status and tell
 * the channels. Each cancel reads the active tasks again, so an author that starts after research
 * meanwhile ends too, and so does a task an earlier instance did not reach.
 */
async function goOnWithWorkflowEnd(workflow: WorkflowRuntime, end: WorkflowEnd): Promise<void> {
  const reason = end.status === "done" ? "the workflow is done" : end.reason;
  const nextActive = () => workflow.store.activeAuthorAndResearcherTasks()[0];
  for (let task = nextActive(); task; task = nextActive()) {
    await cancelTask(workflow, task, reason);
  }
  for (const task of workflow.store.activeRefinerRuns()) await cancelTask(workflow, task, reason);
  await writeWorkflowStatus(workflow, end.status);
  await announceWorkflowEnd(workflow, end);
  workflow.patchState({ workflow_end: null });
}

/**
 * Tell the channels how the workflow ended, and drop its code host bindings. A done workflow
 * completes each session's issue.
 */
async function announceWorkflowEnd(workflow: WorkflowRuntime, end: WorkflowEnd): Promise<void> {
  const to = { answering: end.answering };
  switch (end.status) {
    case "done":
      workflow.log(null, `finished: ${end.reason}`);
      await workflow.post({ type: "done", result: end.reason }, to);
      for (const target of workflow.state.reply_targets) {
        if (target.source === "tracker") await workflow.notifier.moveIssue(target, "completed");
      }
      break;
    case "failed":
      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);
      break;
    case "cancelled":
      await workflow.post({ type: "info", text: `Cancelled. ${TAG_TO_START_AGAIN}` }, to);
      break;
    default: {
      const unhandled: never = end.status;
      throw new Error(`unknown workflow end status ${String(unhandled)}`);
    }
  }
  await unbindCodeHost(workflow);
}

/** Point an external object (pull, branch, page) at this workflow so ingress can route to it. */
export async function bindWorkflow(workflow: WorkflowRuntime, binding: Binding): Promise<void> {
  const db = createDb(workflow.env.DB);
  await bindInDb(db, binding, workflow.state.workflow_id);
}

/**
 * Move the workflow to a new status. The router reads the D1 copy to drop machine events on a
 * finished workflow without waking it.
 */
export async function changeWorkflowStatus(
  workflow: WorkflowRuntime,
  status: WorkflowStatus,
): Promise<void> {
  if (workflow.state.status === status) return;
  await writeWorkflowStatus(workflow, status);
}

/**
 * The only writer of the status and its D1 copy. A resumed workflow end writes both even when the
 * instance holds the status, since an instance restart may have cut off the D1 write.
 */
async function writeWorkflowStatus(
  workflow: WorkflowRuntime,
  status: WorkflowStatus,
): Promise<void> {
  workflow.patchState({ status });
  const db = createDb(workflow.env.DB);
  await setWorkflowStatus(db, workflow.state.workflow_id, status);
}

/** The bindings a workflow takes on the code host: its branches and its pull requests. */
const CODE_SOURCES: BindingSource[] = ["code_branch", "code_pull"];

/**
 * The workflow ended, whichever way, so its code host bindings go. The chat, tracker session, and
 * issue bindings stay, so a person's next message on them starts a new workflow.
 */
async function unbindCodeHost(workflow: WorkflowRuntime): Promise<void> {
  const db = createDb(workflow.env.DB);
  await deleteBindings(db, workflow.state.workflow_id, CODE_SOURCES);
}

/** What the agent says when the humans have been silent for `orchestrator.idle_hours`. */
export const SLEEP_TEXT =
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

/** Put a running workflow to sleep when no harness is at work. */
export async function onIdle(workflow: WorkflowRuntime): Promise<void> {
  workflow.patchState({ idle_alarm: null });
  if (workflow.store.activeAuthorAndResearcherTasks().some((task) => BUSY.has(task.status))) return;
  if (workflow.state.status !== "running") return;
  workflow.log(null, "idle. going to sleep.");
  await changeWorkflowStatus(workflow, "waiting_input");
  await workflow.post({ type: "info", text: SLEEP_TEXT });
}
