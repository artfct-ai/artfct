import type { Harness } from "@artfct-ai/adapters/harness/types";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { ArtifactClose, ArtifactTarget } from "../artifact/types";
import { branchName, jobId as makeJobId, newToken, taskId as makeTaskId } from "../ids";
import { resolveStage, type ResolvedStage } from "../config/stage";
import { noteMessage } from "../agent/transcript/envelope";
import { bindWorkflow as bindInDb, deleteBindings } from "../db/bindings";
import { createDb } from "../db/client";
import { dropWatch, keepWatch, type Watch } from "../db/watches";
import { writeWorkflowRow } from "../db/workflows";
import { TAG_TO_START_AGAIN } from "../notify/messages";
import { dropBoardFlush, flushBoards } from "./board/board";
import { closeAbandonedTurnFeed, STOPPED_CLOSING } from "./feed/feed";
import { onReviewerFailed } from "./refiner/loop";
import { endPolisherRun } from "./refiner/polish";
import { refinerRunOf } from "./refiner/stage-refiner";
import { markArtifactReady } from "./refiner/outcome";
import { jobCompletesSingleIssueWorkflow } from "./subject";
import type { Wake, WorkflowRuntime } from "./types";
import type { JobRow, NewTask, TaskRow } from "./store/tasks";
import { jobInputKey } from "./store/input-key";
import {
  isTaskFinished,
  isWorkflowFinished,
  jobSlotsOf,
  type WorkflowEnd,
  type WorkflowLifecycle,
} from "./store/state";
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
  const { store } = workflow;
  const opened = store.requireConversation();
  const { repo } = store.requireWorkflowRow();
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
  const jobId = makeJobId(opened.conversation_id, store.jobCount() + 1);
  const { input } = options;
  const issue = input.kind === "issue" ? input.issue : null;
  const target = input.kind === "target" ? input.target : null;
  const title = issue?.title ?? options.title ?? store.requireWorkflowRow().name;
  const branch = stage.branch ? (options.continued_branch ?? branchName(jobId, title)) : null;
  const issueLinked = issue !== null && workflow.store.jobByIssue(issue.id) !== null;
  workflow.store.insertJob({
    job_id: jobId,
    stage: stage.name,
    issue_id: issue?.id ?? null,
    issue_key: issue?.key ?? null,
    input_kind: input.kind,
    input_key: jobInputKey(input),
    preceding_job_id: input.kind === "artifact" ? input.jobId : null,
    input_ref: target?.ref ?? null,
    input_url: target?.url ?? null,
    branch,
    brief: options.brief,
    author_harness: options.harness ?? null,
    author_model: options.model ?? null,
  });
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
    const { origin } = opened;
    const subject = store.subject();
    const syncedAsSubject = subject?.kind === "issue" && subject.issue_id === issue.id;
    if (origin?.source === "chat" && !issueLinked && !syncedAsSubject) {
      await workflow.notifier.linkChatThread(ref, origin);
    }
  }
  if (branch && repo) {
    await bindWorkflow(workflow, { source: "code_branch", repo, branch });
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
  const { conversation_id: conversationId } = workflow.store.requireConversation();
  const taskId = makeTaskId(conversationId, workflow.store.taskCount() + 1);
  const { harness, ...fields } = task;
  const sandbox = harness === null ? null : { harness, bridge_token: newToken() };
  workflow.store.insertTask({ ...fields, task_id: taskId, sandbox });
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
  await finishTask(workflow, researcher, async () => {
    workflow.store.completeTodos(researcher.task_id);
    const job = workflow.store.requireJob(researcher.job_id);
    const authorId = insertJobTask(workflow, authorTaskOf(workflow.stageFor(job), job));
    await workflow.scheduleAlarm(0, "provision", { task_id: authorId });
    await dropBoardFlush(workflow, researcher.task_id);
    await flushBoards(workflow, researcher.job_id);
  });
}

/**
 * What is left after a job completed: the workflow it ended, or the author tasks still active and
 * the free slots.
 */
export type CompleteOutcome =
  | { ended: "workflow" }
  | { ended: "job"; running: number; slots: number };

/**
 * Write the status that ends the task, and with it end the model turn of a model-call task. False
 * when the task had already finished.
 */
function markTaskFinished(
  workflow: WorkflowRuntime,
  task: TaskRow,
  status: "done" | "cancelled" | "failed",
): boolean {
  if (isTaskFinished(workflow.store.requireTask(task.task_id).status)) return false;
  workflow.store.updateTask(task.task_id, { status, model_turn_id: null });
  return true;
}

/** Stop the timers of a finished task and destroy its sandbox. One without a sandbox drops its queue. */
async function removeSandbox(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  const sandbox = workflow.store.sandbox(task.task_id);
  if (!sandbox) {
    workflow.store.clearPromptQueue(task.task_id);
    return;
  }
  await clearTaskTimers(workflow, sandbox);
  await destroySandbox(workflow, task);
}

/**
 * End the task done, run `handOn`, then destroy its sandbox. The task end alarm stays armed until
 * the destroy returns, so a restart during the destroy loses only the destroy, which the alarm runs again.
 */
export async function finishTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  handOn: () => Promise<void>,
): Promise<void> {
  const finished = markTaskFinished(workflow, task, "done");
  const teardown = finished
    ? await armTaskEndAlarm(workflow, task, { task_id: task.task_id })
    : null;
  await handOn();
  if (!teardown) return;
  await removeSandbox(workflow, task);
  await closeTeardown(workflow, task, teardown);
}

/**
 * The payload of a task end alarm: the finished task, why a cancelled or failed one ended, and the
 * result of the job a done author completed. Any other done task only destroys its sandbox again.
 */
export type TaskEndAlarm =
  | { task_id: string }
  | { task_id: string; reason: string }
  | { task_id: string; result: string };

/** The task end alarm that a teardown this instance runs holds now. */
type TaskTeardown = { alarmId: string };

/** How long a task end alarm waits before it goes on with a teardown that a restart cut off. */
const TASK_END_ALARM_SECONDS = 60;

const teardownsInFlight = new WeakMap<WorkflowRuntime, Map<string, TaskTeardown>>();

/**
 * Cancel or fail the task: write its status, arm its task end alarm, and destroy its sandbox. Null
 * when the task had already finished.
 */
async function endTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  status: "cancelled" | "failed",
  reason: string,
): Promise<TaskTeardown | null> {
  if (!markTaskFinished(workflow, task, status)) return null;
  return removeSandboxOfEndedTask(workflow, task, { task_id: task.task_id, reason });
}

/**
 * Arm the task end alarm, then destroy the sandbox. The alarm stays armed until the teardown
 * finishes, so an instance restart before that leaves the alarm to run it again.
 */
async function removeSandboxOfEndedTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  alarm: TaskEndAlarm,
): Promise<TaskTeardown> {
  const teardown = await armTaskEndAlarm(workflow, task, alarm);
  await removeSandbox(workflow, task);
  return teardown;
}

/** Arm the task end alarm of a finished task, and note that this instance runs its teardown. */
async function armTaskEndAlarm(
  workflow: WorkflowRuntime,
  task: TaskRow,
  alarm: TaskEndAlarm,
): Promise<TaskTeardown> {
  const teardown = {
    alarmId: await workflow.scheduleAlarm(TASK_END_ALARM_SECONDS, "resumeTaskEnd", alarm),
  };
  const inFlight = teardownsInFlight.get(workflow) ?? new Map<string, TaskTeardown>();
  teardownsInFlight.set(workflow, inFlight);
  inFlight.set(task.task_id, teardown);
  return teardown;
}

/**
 * Finish the teardown of a cancelled or failed task once its sandbox is gone: end what the task
 * held, cancel its task end alarm, then tell the agent.
 */
async function finishTeardown(
  workflow: WorkflowRuntime,
  task: TaskRow,
  teardown: TaskTeardown,
  reason: string,
): Promise<void> {
  const ended = workflow.store.requireTask(task.task_id).status;
  const note =
    ended === "cancelled"
      ? await endWorkOfCancelledTask(workflow, task, reason)
      : await endWorkOfFailedTask(workflow, task, reason);
  await closeTeardown(workflow, task, teardown);
  if (note) await workflow.tellAgent(note.text, note.wake);
}

/** The last call of the teardown returned, so its task end alarm is cancelled. */
async function closeTeardown(
  workflow: WorkflowRuntime,
  task: TaskRow,
  teardown: TaskTeardown,
): Promise<void> {
  teardownsInFlight.get(workflow)?.delete(task.task_id);
  await workflow.cancelAlarm(teardown.alarmId);
}

/** What the agent hears once the teardown of a task finished. */
type EndNote = { text: string; wake: Wake };

/**
 * Alarm: go on with the teardown of a finished task that an instance restart cut off. A completed
 * job ends its review again, and any other done task only destroys its sandbox again. While this
 * instance still runs that teardown, the alarm is armed again instead.
 */
export async function resumeTaskEnd(workflow: WorkflowRuntime, alarm: TaskEndAlarm): Promise<void> {
  const task = workflow.store.requireTask(alarm.task_id);
  const running = teardownsInFlight.get(workflow)?.get(task.task_id);
  if (running) {
    const rearmed = await workflow.scheduleAlarm(TASK_END_ALARM_SECONDS, "resumeTaskEnd", alarm);
    // The teardown can finish while the alarm is armed again.
    if (teardownsInFlight.get(workflow)?.get(task.task_id) === running) running.alarmId = rearmed;
    else await workflow.cancelAlarm(rearmed);
    return;
  }
  const teardown = await removeSandboxOfEndedTask(workflow, task, alarm);
  if ("reason" in alarm) await finishTeardown(workflow, task, teardown, alarm.reason);
  else if ("result" in alarm) await finishCompletion(workflow, task, teardown, alarm.result);
  else await closeTeardown(workflow, task, teardown);
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

/**
 * The agent judged the job done. Tear its author task down, then end the workflow when the job
 * completes a single-issue workflow, or say how many slots are left.
 */
export async function completeJob(
  workflow: WorkflowRuntime,
  author: TaskRow,
  result: string,
): Promise<CompleteOutcome> {
  workflow.log(author.task_id, `done: ${result}`);
  if (markTaskFinished(workflow, author, "done")) {
    const alarm = { task_id: author.task_id, result };
    const teardown = await removeSandboxOfEndedTask(workflow, author, alarm);
    await finishCompletion(workflow, author, teardown, result);
  }
  if (jobCompletesSingleIssueWorkflow(workflow, workflow.store.requireJob(author.job_id))) {
    return { ended: "workflow" };
  }
  const running = workflow.store.activeAuthorAndResearcherTasks().length;
  return {
    ended: "job",
    running,
    slots: Math.max(0, jobSlotsOf(workflow.store.stagePlan()) - running),
  };
}

/**
 * Finish the teardown of a completed job once its author's sandbox is gone: end the review, cancel
 * the task end alarm, then end the workflow when the job completes a single-issue workflow. Each
 * part does nothing the second time, so the task end alarm can run them again.
 */
async function finishCompletion(
  workflow: WorkflowRuntime,
  author: TaskRow,
  teardown: TaskTeardown,
  result: string,
): Promise<void> {
  await endReviewAndBoard(workflow, author.job_id, {
    reason: "the job is complete",
    close: { close: "ready" },
  });
  await closeTeardown(workflow, author, teardown);
  if (jobCompletesSingleIssueWorkflow(workflow, workflow.store.requireJob(author.job_id))) {
    await completeWorkflow(workflow, result);
  }
}

/**
 * The work is complete. Any task still running ends with it. The channels hear the result. Each
 * session's issue completes.
 */
export async function completeWorkflow(workflow: WorkflowRuntime, result: string): Promise<void> {
  await endWorkflow(workflow, { ends_as: "done", reason: result, answering: [], posted: false });
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
  const [, teardown] = await Promise.all([
    closeAbandonedTurnFeed(workflow, task, STOPPED_CLOSING),
    endTask(workflow, task, "cancelled", reason),
  ]);
  if (teardown) await finishTeardown(workflow, task, teardown, reason);
}

/** End the polisher run, or the job of an author or researcher, of a cancelled task. */
async function endWorkOfCancelledTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<EndNote | null> {
  switch (task.role) {
    case "polisher":
      await endPolisherRun(workflow, task, {
        ended: "stopped",
        reason: `the polisher was cancelled: ${reason}`,
      });
      return null;
    case "reviewer":
      return null;
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
  return { text: noteMessage(`Job ${task.job_id} was cancelled: ${reason}`), wake: "none" };
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
  const teardown = await endTask(workflow, task, "failed", reason);
  if (teardown) await finishTeardown(workflow, task, teardown, reason);
}

/**
 * End the polisher run or the reviewer of a failed task. A failed author or researcher ends the
 * review of its job and posts its failure.
 */
async function endWorkOfFailedTask(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<EndNote | null> {
  switch (task.role) {
    case "polisher":
      await endPolisherRun(workflow, task, { ended: "stopped", reason });
      return null;
    case "reviewer":
      await onReviewerFailed(workflow, task, reason);
      return null;
    case "author":
    case "researcher":
      break;
  }
  await endReviewAndBoard(workflow, task.job_id, {
    reason,
    close: { close: "blocked", reason: `The job failed before the review settled (${reason}).` },
  });
  await workflow.post({ type: "failed", job_id: task.job_id, reason });
  return {
    text: noteMessage(
      `Job ${task.job_id} failed: its ${task.role} ${task.task_id} stopped (${reason}). Retry its work with start_job, or call fail_workflow.`,
    ),
    wake: "task_result",
  };
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
  await endWorkflow(workflow, { ends_as: "failed", reason, answering: [], posted: false });
}

/** True from the start of a workflow end until its last step. */
export function workflowEnding(workflow: WorkflowRuntime): boolean {
  return workflow.store.workflowRow()?.status === "ending";
}

/**
 * Start the workflow end in the store before its first cancel, then go on with it. False when the
 * conversation has no workflow, or it already ended or another end runs, so the caller says nothing.
 */
export async function endWorkflow(workflow: WorkflowRuntime, end: WorkflowEnd): Promise<boolean> {
  if (!workflow.store.workflowRow() || workflow.store.workflowFinished()) return false;
  workflow.store.startWorkflowEnd(end);
  await goOnWithWorkflowEnd(workflow, end);
  return true;
}

/**
 * Start step: arm the alarm that goes on with the end of an ending workflow. A later restart
 * before it fires leaves the one alarm armed.
 */
export async function armWorkflowEndAlarm(workflow: WorkflowRuntime): Promise<void> {
  if (workflow.store.workflowRow()?.status !== "ending") return;
  await workflow.scheduleAlarmOnce("resumeWorkflowEnd", {});
}

/**
 * Start the end of the active workflow and leave the rest of it to the alarm that goes on with an
 * end, so the caller returns before the end's calls. A workflow whose end started already keeps it.
 */
export async function startWorkflowEndByAlarm(
  workflow: WorkflowRuntime,
  end: WorkflowEnd,
): Promise<void> {
  if (!workflow.store.workflowRow() || workflow.store.workflowFinished()) return;
  workflow.store.startWorkflowEnd(end);
  await armWorkflowEndAlarm(workflow);
}

/** Alarm: go on with a workflow end that an instance restart cut off, or that a caller left to it. */
export async function resumeWorkflowEnd(workflow: WorkflowRuntime): Promise<void> {
  const end = workflow.store.workflowEnd();
  if (end && workflowEnding(workflow)) await goOnWithWorkflowEnd(workflow, end);
}

/**
 * Cancel every active task, author and researcher tasks first, then write the final status to the
 * router and tell the channels. Each cancel reads the active tasks again, so an author that starts
 * after research meanwhile ends too, and so does a task an earlier instance did not reach. An end
 * that posted before an instance restart does not post again. The last step moves it to `ended`.
 */
async function goOnWithWorkflowEnd(workflow: WorkflowRuntime, end: WorkflowEnd): Promise<void> {
  const reason = end.ends_as === "done" ? "the workflow is done" : end.reason;
  const nextActive = () => workflow.store.activeAuthorAndResearcherTasks()[0];
  for (let task = nextActive(); task; task = nextActive()) {
    await cancelTask(workflow, task, reason);
  }
  for (const task of workflow.store.activeRefinerRuns()) await cancelTask(workflow, task, reason);
  await writeRouterWorkflowStatus(workflow);
  if (!end.posted) await postWorkflowEnd(workflow, end);
  if (end.ends_as === "done") await completeTrackerIssues(workflow);
  await unbindWorkflow(workflow);
  workflow.store.updateWorkflow({ status: "ended" });
}

/** Tell the channels how the workflow ended, and record in the workflow end that it posted. */
async function postWorkflowEnd(workflow: WorkflowRuntime, end: WorkflowEnd): Promise<void> {
  const to = { answering: end.answering };
  switch (end.ends_as) {
    case "done":
      workflow.log(null, `finished: ${end.reason}`);
      await workflow.post({ type: "done", result: end.reason }, to);
      break;
    case "failed":
      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);
      break;
    case "cancelled":
      await workflow.post({ type: "info", text: `Cancelled. ${TAG_TO_START_AGAIN}` }, to);
      break;
    default: {
      const unhandled: never = end.ends_as;
      throw new Error(`unknown workflow end status ${String(unhandled)}`);
    }
  }
  workflow.store.markWorkflowEndPosted();
}

/** A done workflow completes each session's issue. */
async function completeTrackerIssues(workflow: WorkflowRuntime): Promise<void> {
  for (const target of workflow.store.replyTargets()) {
    if (target.source === "tracker") await workflow.notifier.moveIssue(target, "completed");
  }
}

/** Point an object the workflow works on, such as a pull request, a branch, or a page, at it. */
export async function bindWorkflow(workflow: WorkflowRuntime, binding: Binding): Promise<void> {
  const db = createDb(workflow.env.DB);
  await bindInDb(db, binding, workflow.store.requireWorkflowRow().workflow_id);
}

/** Move a workflow whose end has not started between running and waiting for input. */
export async function changeWorkflowStatus(
  workflow: WorkflowRuntime,
  status: Extract<WorkflowLifecycle, "running" | "waiting_input">,
): Promise<void> {
  if (workflow.store.requireWorkflowRow().status === status) return;
  workflow.store.updateWorkflow({ status });
  await writeRouterWorkflowStatus(workflow);
}

/**
 * Write the active workflow's status to the router's row of it, which the router reads to route
 * only through running workflows. The plan that creates the workflow writes it first. The start
 * step and a resumed workflow end write it again, since an instance restart may have cut a write.
 */
export async function writeRouterWorkflowStatus(workflow: WorkflowRuntime): Promise<void> {
  const active = workflow.store.activeWorkflow();
  if (!active) return;
  const db = createDb(workflow.env.DB);
  const status = workflow.store.workflowStatus();
  const conversation = workflow.store.requireConversation();
  const write = writeWorkflowRow(db, {
    workflow_id: active.workflow_id,
    conversation_id: conversation.conversation_id,
    status,
  });
  const watch = watchOf(workflow);
  if (!watch || isWorkflowFinished(status)) {
    await write;
    return;
  }
  await db.batch([write, keepWatch(db, watch, active.workflow_id)]);
}

/**
 * The watch of the conversation's workflow: the pull request a firing opened the conversation on,
 * with the workflow's definition. Null for a conversation of any other place.
 */
function watchOf(workflow: WorkflowRuntime): Watch | null {
  const { origin } = workflow.store.requireConversation();
  if (origin?.source !== "code") return null;
  const { definition } = workflow.store.requireWorkflowRow();
  return { repo: origin.repo, number: origin.pull, definition };
}

/**
 * The workflow ended, whichever way, so every binding it holds goes, and its watch with them. The
 * conversation stays.
 */
async function unbindWorkflow(workflow: WorkflowRuntime): Promise<void> {
  const db = createDb(workflow.env.DB);
  const unbind = deleteBindings(db, workflow.store.requireWorkflowRow().workflow_id);
  const watch = watchOf(workflow);
  await (watch ? db.batch([unbind, dropWatch(db, watch)]) : unbind);
}

/** What the agent says when the humans have been silent for `orchestrator.idle_hours`. */
export const SLEEP_TEXT =
  "I have not heard back, so I am going to sleep for now. Tag me here to continue.";

/** Task statuses in which a harness is at work, so the workflow is not waiting on a human. */
const BUSY = new Set(["queued", "provisioning", "working"]);

/** Start the idle clock over. One alarm at a time: the previous one is cancelled first. */
export async function armIdle(workflow: WorkflowRuntime): Promise<void> {
  const hours = workflow.config().orchestrator.idle_hours;
  const armed = workflow.store.requireWorkflowRow().idle_schedule;
  if (armed) await workflow.cancelAlarm(armed);
  if (!hours) return;
  const id = await workflow.scheduleAlarm(hours * 3600, "onIdle", {});
  workflow.store.updateWorkflow({ idle_schedule: id });
}

/** Put a running workflow to sleep when no harness is at work. */
export async function onIdle(workflow: WorkflowRuntime): Promise<void> {
  workflow.store.updateWorkflow({ idle_schedule: null });
  if (workflow.store.activeAuthorAndResearcherTasks().some((task) => BUSY.has(task.status))) return;
  if (workflow.store.requireWorkflowRow().status !== "running") return;
  workflow.log(null, "idle. going to sleep.");
  await changeWorkflowStatus(workflow, "waiting_input");
  await workflow.post({ type: "info", text: SLEEP_TEXT });
}
