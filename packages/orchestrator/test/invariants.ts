import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ArtifactStatus, TaskStatus, WorkflowStatus } from "@artfct-ai/contracts/types";
import { ASK_WHETHER_ACCEPTED, ASK_WHICH_OPTION } from "../src/agent/tools/start/start";
import { channelKey } from "../src/workflow/board/board";
import type { TaskRole } from "../src/workflow/task/events";
import type { Wake, WorkflowRuntime } from "../src/workflow/types";

/** One task row as an observer saw it. `ruling` is the stored ruling as text, or null. */
export type ObservedTask = {
  task_id: string;
  role: TaskRole;
  status: TaskStatus;
  job_id: string;
  refiner_index: number | null;
  ruling: string | null;
  /** True when the task's latest turn ended normally and the task took no prompt since. */
  quietSinceTurnEnd: boolean;
};

/** One artifact row as an observer saw it. */
export type ObservedArtifact = {
  job_id: string;
  status: ArtifactStatus;
  delivered_to_humans_at: string | null;
  delivered_revision: string | null;
};

/** What an observer saw of the workflow between two actions. */
export type Observation = {
  workflowStatus: WorkflowStatus;
  tasks: ObservedTask[];
  artifacts: ObservedArtifact[];
  /** The todo list of each task, as text. */
  todos: Record<string, string>;
  /** Prompts queued for authors plus prompts sent to authors, since the workflow began. */
  authorPrompts: number;
};

/** One action and what an observer saw around it. */
export type Step = {
  action: string;
  before: Observation;
  after: Observation;
  /** What the agent was told during the action. */
  notes: Array<{ text: string; wake: Wake }>;
  /** Set when an author turn ended. `hostRevision` is null when the host could not say one. */
  authorTurnEnd: { task_id: string; hostRevision: string | null } | null;
  /** Set when a person's feedback event was delivered. */
  feedback: { task_id: string } | null;
  /** Set when an inbound event was delivered. */
  event: { kind: InboundEvent["kind"] } | null;
  /** Set when the turn of a refiner run ended normally. */
  refinerTurnEnd: { task_id: string } | null;
  /** Set when the alarm that fired was armed for an older generation of its task. */
  staleAlarm: { task_id: string } | null;
  /**
   * Set when the agent called complete_job. `checkFailed` is true when the decisions model could
   * not check what the person wrote. `result` is what the tool answered.
   */
  completion: { task_id: string; checkFailed: boolean; result: string } | null;
  /**
   * Set when feedback the screen could not admit was delivered or sent. `texts` are what it said.
   * `agentRead` is the tool result the agent read about it, or null when no tool ran.
   */
  unadmittedFeedback: { texts: string[]; agentRead: string | null } | null;
};

const FINISHED: TaskStatus[] = ["done", "failed", "cancelled"];

const JOB_ROLES: TaskRole[] = ["author", "researcher"];

const REFINER_ROLES: TaskRole[] = ["reviewer", "polisher"];

const FINISHED_WORKFLOW: WorkflowStatus[] = ["done", "failed", "cancelled"];

const ARTIFACT_MOVES: Array<[ArtifactStatus, ArtifactStatus]> = [
  ["drafted", "ready"],
  ["ready", "drafted"],
  ["drafted", "accepted"],
  ["ready", "accepted"],
  ["drafted", "removed"],
  ["ready", "removed"],
];

function violated(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`);
}

function artifactIn(observation: Observation, jobId: string): ObservedArtifact | null {
  return observation.artifacts.find((artifact) => artifact.job_id === jobId) ?? null;
}

function authorIn(observation: Observation, jobId: string): ObservedTask | null {
  return observation.tasks.find((task) => task.role === "author" && task.job_id === jobId) ?? null;
}

/** `delivered_to_humans_at` is never cleared once it is set. */
export function deliveredToHumansIsNeverCleared(_workflow: WorkflowRuntime, step: Step): void {
  for (const before of step.before.artifacts) {
    if (before.delivered_to_humans_at === null) continue;
    if (artifactIn(step.after, before.job_id)?.delivered_to_humans_at == null) {
      violated("deliveredToHumansIsNeverCleared", `${before.job_id} lost delivered_to_humans_at`);
    }
  }
}

/**
 * A refiner run starts on an artifact the humans have only when an author turn ended on a
 * revision they have not seen. A host that cannot say the revision counts as a changed one.
 */
export function refinersRunAgainOnlyOnChangedRevision(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const known = new Set(step.before.tasks.map((task) => task.task_id));
  for (const run of step.after.tasks) {
    if (known.has(run.task_id) || !REFINER_ROLES.includes(run.role)) continue;
    const before = artifactIn(step.before, run.job_id);
    if (!before || before.status === "drafted") continue;
    const turn = step.authorTurnEnd;
    const changed =
      turn !== null &&
      turn.task_id === authorIn(step.after, run.job_id)?.task_id &&
      (turn.hostRevision === null || turn.hostRevision !== before.delivered_revision);
    if (!changed) {
      violated(
        "refinersRunAgainOnlyOnChangedRevision",
        `${run.task_id} started on a ${before.status} artifact delivered at ${before.delivered_revision}`,
      );
    }
  }
}

/** A judge entry rules at most once on an artifact, and its ruling never changes. */
export function judgeRulesAtMostOnce(workflow: WorkflowRuntime, step: Step): void {
  for (const author of step.after.tasks.filter((task) => task.role === "author")) {
    const reviewers = workflow.stageFor(workflow.store.requireJob(author.job_id)).reviewers;
    const ruled = step.after.tasks.filter(
      (run) =>
        run.job_id === author.job_id &&
        run.role === "reviewer" &&
        run.refiner_index !== null &&
        reviewers[run.refiner_index]?.mode === "judge" &&
        run.ruling !== null,
    );
    const indexes = ruled.map((run) => run.refiner_index);
    if (new Set(indexes).size !== indexes.length) {
      violated(
        "judgeRulesAtMostOnce",
        `${ruled.map((run) => run.task_id).join(", ")} ruled on one entry`,
      );
    }
    for (const run of ruled) {
      const earlier = step.before.tasks.find((task) => task.task_id === run.task_id)?.ruling;
      if (earlier != null && earlier !== run.ruling) {
        violated("judgeRulesAtMostOnce", `${run.task_id} went from ${earlier} to ${run.ruling}`);
      }
    }
  }
}

/**
 * Every feedback event on a running workflow gets exactly one routing decision: a prompt for the
 * author, a note that wakes the agent, or the note that it asks for nothing. Never silence, and
 * never two.
 */
export function everyFeedbackGetsOneRoutingDecision(_workflow: WorkflowRuntime, step: Step): void {
  if (!step.feedback || FINISHED_WORKFLOW.includes(step.before.workflowStatus)) return;
  const decisions = [
    step.after.authorPrompts > step.before.authorPrompts ? "author" : null,
    step.notes.some((note) => note.wake === "human") ? "agent" : null,
    step.notes.some((note) => note.text.includes("It asks for nothing")) ? "nobody" : null,
  ].filter((decision) => decision !== null);
  if (decisions.length !== 1) {
    violated(
      "everyFeedbackGetsOneRoutingDecision",
      `feedback on ${step.feedback.task_id} was routed to [${decisions.join(", ")}]`,
    );
  }
}

/**
 * On a finished workflow, no event changes the status, the tasks, or the prompts, and the agent
 * gets no note.
 */
export function nothingReopensAFinishedWorkflow(_workflow: WorkflowRuntime, step: Step): void {
  if (!step.event || !FINISHED_WORKFLOW.includes(step.before.workflowStatus)) return;
  const changes = [
    step.after.workflowStatus !== step.before.workflowStatus ? "the workflow status" : null,
    step.after.tasks.length !== step.before.tasks.length ? "the tasks" : null,
    step.after.authorPrompts !== step.before.authorPrompts ? "the author prompts" : null,
    step.notes.length > 0 ? "the agent notes" : null,
  ].filter((change) => change !== null);
  if (changes.length > 0) {
    violated(
      "nothingReopensAFinishedWorkflow",
      `a ${step.event.kind} event changed ${changes.join(", ")} of a ${step.before.workflowStatus} workflow`,
    );
  }
}

/** Every board lives in a chat thread the workflow replies to. A tracker session never holds one. */
export function boardsLiveOnlyInChat(workflow: WorkflowRuntime): void {
  const threads = new Set(
    workflow.state.reply_targets
      .filter((target) => target.source === "chat")
      .map((target) => channelKey(target)),
  );
  for (const job of workflow.store.jobs()) {
    for (const board of workflow.store.boards(job.job_id)) {
      if (!threads.has(board.channel_key)) {
        violated("boardsLiveOnlyInChat", `${job.job_id} has a board at ${board.channel_key}`);
      }
    }
  }
}

/** A task cannot be `in_review` without an artifact on its job. */
export function inReviewTaskHasAnArtifact(workflow: WorkflowRuntime): void {
  for (const task of workflow.store.tasks()) {
    if (task.status === "in_review" && !workflow.store.artifact(task.job_id)) {
      violated("inReviewTaskHasAnArtifact", `${task.task_id} is in_review with no artifact`);
    }
  }
}

/**
 * A refiner run ends `done` only when its turn ended normally. A polisher that waits on the
 * checks of its push ends in a later step, and only when it took no prompt since that turn end.
 */
export function refinerRunIsDoneOnlyAfterItsTurnEnded(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  for (const after of step.after.tasks) {
    if (!REFINER_ROLES.includes(after.role) || after.status !== "done") continue;
    const before = step.before.tasks.find((task) => task.task_id === after.task_id);
    if (before?.status === "done" || step.refinerTurnEnd?.task_id === after.task_id) continue;
    if (before?.role === "polisher" && before.quietSinceTurnEnd) continue;
    violated(
      "refinerRunIsDoneOnlyAfterItsTurnEnded",
      `${after.task_id} went from ${before?.status ?? "nothing"} to done with no turn end`,
    );
  }
}

/** A finished task never changes status again. */
export function finishedTaskKeepsItsStatus(_workflow: WorkflowRuntime, step: Step): void {
  for (const before of step.before.tasks) {
    if (!FINISHED.includes(before.status)) continue;
    const after = step.after.tasks.find((task) => task.task_id === before.task_id);
    if (after?.status !== before.status) {
      violated(
        "finishedTaskKeepsItsStatus",
        `${before.task_id} went from ${before.status} to ${after?.status ?? "nothing"}`,
      );
    }
  }
}

/**
 * An artifact status moves only `drafted` to `ready`, `ready` to `drafted`, and either of them
 * to `accepted` or `removed`. `accepted` and `removed` are final.
 */
export function artifactStatusMovesAreLegal(_workflow: WorkflowRuntime, step: Step): void {
  for (const before of step.before.artifacts) {
    const after = artifactIn(step.after, before.job_id);
    if (after?.status === before.status) continue;
    const legal = ARTIFACT_MOVES.some(
      ([from, to]) => from === before.status && to === after?.status,
    );
    if (!legal) {
      violated(
        "artifactStatusMovesAreLegal",
        `${before.job_id} went from ${before.status} to ${after?.status ?? "nothing"}`,
      );
    }
  }
}

/**
 * The todo list of a task should never change after its job records an artifact. A researcher task
 * should never record an artifact.
 */
export function todoListIsFixedAfterFirstArtifact(_workflow: WorkflowRuntime, step: Step): void {
  for (const artifact of step.after.artifacts) {
    if (authorIn(step.after, artifact.job_id)) continue;
    violated(
      "todoListIsFixedAfterFirstArtifact",
      `${artifact.job_id} recorded an artifact while only its researcher ran`,
    );
  }
  for (const artifact of step.before.artifacts) {
    const author = authorIn(step.before, artifact.job_id);
    if (!author) continue;
    const before = step.before.todos[author.task_id];
    const after = step.after.todos[author.task_id];
    if (before !== after) {
      violated(
        "todoListIsFixedAfterFirstArtifact",
        `${author.task_id} todos went from ${before} to ${after}`,
      );
    }
  }
}

/**
 * An artifact has at most one unfinished refiner run, and `refiner_task_id` points at it when
 * one exists.
 */
export function oneUnfinishedRefinerRunPerArtifact(workflow: WorkflowRuntime): void {
  const tasks = workflow.store.tasks();
  for (const author of tasks.filter((task) => task.role === "author")) {
    const unfinished = tasks.filter(
      (run) =>
        run.job_id === author.job_id &&
        REFINER_ROLES.includes(run.role) &&
        !FINISHED.includes(run.status),
    );
    const ids = unfinished.map((run) => run.task_id).join(", ");
    if (unfinished.length > 1) {
      violated("oneUnfinishedRefinerRunPerArtifact", `${author.task_id} has ${ids} unfinished`);
    }
    const pointer = workflow.store.artifact(author.job_id)?.refiner_task_id ?? null;
    if (unfinished.length === 1 && pointer !== unfinished[0]!.task_id) {
      violated(
        "oneUnfinishedRefinerRunPerArtifact",
        `${ids} is unfinished and refiner_task_id of ${author.task_id} is ${pointer}`,
      );
    }
  }
}

/**
 * The author and a polisher never work at once: while a polisher run is unfinished, its author
 * has no prompt in flight. A reviewer run only reads, so it does not stop the author.
 */
export function authorIsIdleWhileAPolisherRuns(workflow: WorkflowRuntime): void {
  for (const run of workflow.store.tasks()) {
    if (run.role !== "polisher" || FINISHED.includes(run.status)) continue;
    const author = workflow.store.authorTaskOf(run.job_id);
    if (workflow.store.requireSandbox(author.task_id).prompt_in_flight) {
      violated(
        "authorIsIdleWhileAPolisherRuns",
        `${author.task_id} has a prompt in flight while polisher ${run.task_id} is ${run.status}`,
      );
    }
  }
}

/**
 * A job starts only into a free slot: before the action that started it, the unfinished author
 * and researcher tasks were fewer than the slots. A refiner run takes no slot.
 */
export function jobStartsOnlyIntoAFreeSlot(workflow: WorkflowRuntime, step: Step): void {
  const knownJobs = new Set(step.before.tasks.map((task) => task.job_id));
  const started = step.after.tasks.filter((task) => !knownJobs.has(task.job_id));
  if (started.length === 0) return;
  const unfinished = step.before.tasks.filter(
    (task) => JOB_ROLES.includes(task.role) && !FINISHED.includes(task.status),
  );
  if (unfinished.length >= workflow.state.concurrency) {
    violated(
      "jobStartsOnlyIntoAFreeSlot",
      `${started.map((task) => task.job_id).join(", ")} started with ${unfinished.length} unfinished and ${workflow.state.concurrency} slots`,
    );
  }
}

/** A workflow whose status is done, cancelled, or failed has no unfinished task. */
export function endedWorkflowHasNoUnfinishedTask(workflow: WorkflowRuntime): void {
  const { status } = workflow.state;
  if (!FINISHED_WORKFLOW.includes(status)) return;
  const unfinished = workflow.store.tasks().filter((task) => !FINISHED.includes(task.status));
  if (unfinished.length > 0) {
    violated(
      "endedWorkflowHasNoUnfinishedTask",
      `${unfinished.map((task) => `${task.task_id} (${task.status})`).join(", ")} in a ${status} workflow`,
    );
  }
}

/**
 * A job's input is an artifact like an issue or a document. The only exception is an ad-hoc
 * implementation request, in which case a hash of the message content that requested it is the
 * artifact. Only one job can exist per input artifact.
 */
export function oneLiveJobPerInputArtifact(workflow: WorkflowRuntime): void {
  const owners = new Map<string, string>();
  for (const job of workflow.store.jobs()) {
    const task = workflow.store.authorOrResearcherTaskOf(job.job_id);
    const output = workflow.store.artifact(job.job_id);
    const live = !FINISHED.includes(task.status) || (output && output.status !== "removed");
    if (!live || job.input_key === null) continue;
    const owner = owners.get(job.input_key);
    if (owner) {
      violated(
        "oneLiveJobPerInputArtifact",
        `${owner} and ${job.job_id} both work from ${job.input_key}`,
      );
    }
    owners.set(job.input_key, job.job_id);
  }
}

/**
 * Feedback the screen did not admit, because it quarantined it or could not check it, reaches
 * neither the agent nor the author. No note or tool result holds its text, and no prompt goes out.
 */
export function unadmittedFeedbackReachesNobody(_workflow: WorkflowRuntime, step: Step): void {
  if (!step.unadmittedFeedback) return;
  const { texts, agentRead } = step.unadmittedFeedback;
  for (const text of texts) {
    if (step.notes.some((note) => note.text.includes(text))) {
      violated("unadmittedFeedbackReachesNobody", `a note told the agent "${text}"`);
    }
    if (agentRead?.includes(text)) {
      violated("unadmittedFeedbackReachesNobody", `a tool result told the agent "${text}"`);
    }
  }
  if (step.after.authorPrompts !== step.before.authorPrompts) {
    violated("unadmittedFeedbackReachesNobody", "a prompt went out with the feedback");
  }
}

/**
 * A job completes only on a person's accept or select, or on its host's accept. When the
 * decisions model could not check what the person wrote, the job stays open.
 */
export function aFailedCheckNeverCompletesAJob(_workflow: WorkflowRuntime, step: Step): void {
  const completion = step.completion;
  if (!completion?.checkFailed) return;
  const before = step.before.tasks.find((task) => task.task_id === completion.task_id);
  const after = step.after.tasks.find((task) => task.task_id === completion.task_id);
  if (!after || after.status !== "done" || before?.status === "done") return;
  const artifactBefore = artifactIn(step.before, after.job_id);
  if (artifactBefore === null || artifactBefore.status === "accepted") return;
  if (artifactIn(step.after, after.job_id)?.status === "accepted") return;
  violated(
    "aFailedCheckNeverCompletesAJob",
    `job ${after.job_id} completed although its check failed`,
  );
}

/** A check the decisions model could not make never has the agent ask the person again. */
export function aFailedCheckNeverAsksThePersonAgain(_workflow: WorkflowRuntime, step: Step): void {
  const completion = step.completion;
  if (!completion?.checkFailed) return;
  for (const askAgain of [ASK_WHETHER_ACCEPTED, ASK_WHICH_OPTION]) {
    if (completion.result.includes(askAgain)) {
      violated(
        "aFailedCheckNeverAsksThePersonAgain",
        `the agent was told "${askAgain}" after a failed check`,
      );
    }
  }
}

/** An alarm armed for an older generation of a task changes nothing and tells the agent nothing. */
export function staleAlarmIsIgnored(_workflow: WorkflowRuntime, step: Step): void {
  if (!step.staleAlarm) return;
  const { task_id } = step.staleAlarm;
  if (JSON.stringify(step.before) !== JSON.stringify(step.after)) {
    violated("staleAlarmIsIgnored", `a stale alarm of ${task_id} changed the workflow`);
  }
  if (step.notes.length > 0) {
    violated("staleAlarmIsIgnored", `a stale alarm of ${task_id} told the agent something`);
  }
}
