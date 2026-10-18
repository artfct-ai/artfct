import type { PostedComment } from "@artfct-ai/adapters/test/fake-documents";
import type { InboundEvent, ReplyTarget, VerbalCommand } from "@artfct-ai/contracts/inbound";
import type { ArtifactStatus, TaskStatus, WorkflowStatus } from "@artfct-ai/contracts/types";
import { ASK_WHETHER_ACCEPTED, ASK_WHICH_OPTION } from "../src/agent/tools/start/start";
import type { PlanEntry } from "@agentclientprotocol/sdk";
import { rejectionHeadline } from "../src/prompts/review-prompt";
import { boardInputOf, channelKey } from "../src/workflow/board/board";
import {
  BOARD_MAX_ENTRIES,
  boardText,
  lifecycleLabel,
  renderBoard,
} from "../src/workflow/board/render";
import { MAX_RESTARTS, SLEEP_TEXT } from "../src/workflow/lifecycle";
import type { TaskEvent, TaskRole } from "../src/workflow/task/events";
import { taskAtWork } from "../src/workflow/task/at-work";
import { judgeRuled } from "../src/workflow/refiner/stage-refiner";
import type { Wake, WorkflowRuntime } from "../src/workflow/types";
import { STOPPED_TEXT } from "../src/workflow/feed/feed";
import type { Subject } from "../src/workflow/store/state";
import { artifactRefKey } from "../src/workflow/store/input-key";
import { coverageCase } from "./coverage";
import { ACTION_WORK_BUDGET, exceededWorkBudget } from "./work-budget";
import { worldIssueInSubject } from "./world-tracker";

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
  /** True while a prompt turn of the task runs in its harness over an open bridge. */
  turnRunning: boolean;
  /** The text of every prompt queued for the task or sent to it. */
  promptTexts: string[];
  /** The text of every prompt ever queued for the task, also one a stop or a cancel cleared. */
  promptsQueued: string[];
  /** How many prompts its harness sessions and its model turns took since the workflow began. */
  promptsSent: number;
  paused: boolean;
  /** How many cancels its harness session was sent. */
  cancelsSent: number;
  promptInFlight: boolean;
  queuedPrompts: number;
  handshaking: boolean;
  /** True while the task's turn runs or is about to start, as the workflow reads it. */
  atWork: boolean;
  /** True while a page model call of this instance is out for the model turn the task holds. */
  modelCallOut: boolean;
};

/** One artifact row as an observer saw it. */
export type ObservedArtifact = {
  job_id: string;
  status: ArtifactStatus;
  delivered_to_humans_at: string | null;
  delivered_revision: string | null;
};

/** A job of the workflow: the issue it works on, if any, and its stage. */
export type ObservedJob = { job_id: string; issue_id: string | null; stage: string };

/** What an observer saw of the workflow between two actions. */
export type Observation = {
  /** The one issue or tracker project the workflow works on, or null before it has one. */
  subject: Subject | null;
  /** The last stage of the plan, or null before a plan with stages. */
  lastStage: string | null;
  /** True when a planned stage produces issues. */
  plansIssues: boolean;
  jobs: ObservedJob[];
  workflowStatus: WorkflowStatus;
  /** The workflow definition the workflow runs, or null before the plan that starts it. */
  definition: string | null;
  /** True when a chat thread is among the reply targets. */
  chatThread: boolean;
  /** The tracker session the workflow started from, or null. */
  startingSession: string | null;
  /** The job session of each job, by job id. Null for a job without one. */
  jobSessions: Record<string, string | null>;
  /** How many outbox rows a person can read. */
  posted: number;
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
  /** The world right after each event that landed in the middle of the action, in order. */
  landed: Observation[];
  after: Observation;
  /** What the agent was told during the action. */
  notes: Array<{ text: string; wake: Wake }>;
  /** Set when an author turn ended. `hostRevision` is null when the host could not say one. */
  authorTurnEnd: { task_id: string; hostRevision: string | null; cancelled: boolean } | null;
  /** Set when a person's feedback event was delivered. */
  feedback: { task_id: string } | null;
  /**
   * Set when an inbound event was delivered. `person` is true when a person sent it, and
   * `reply_to` is where they wait for the answer.
   */
  event: {
    kind: InboundEvent["kind"];
    text: string;
    person: boolean;
    reply_to: ReplyTarget | null;
    control: VerbalCommand | null;
  } | null;
  /** Every orchestrator post the step added to a tracker session, in order. */
  sessionPosts: Array<{ session_id: string; kind: string }>;
  /** The type of every event the step posted, wherever it went. */
  postedTypes: TaskEvent["type"][];
  feedPosts: Array<{ task_id: string; kind: string; text: string }>;
  planPosts: string[];
  storedActivities: string[];
  streamedTexts: string[];
  postedTexts: string[];
  /** Set when the agent called start_job. `refused` is true when the tool did not start a job. */
  start: { refused: boolean } | null;
  /** True when the agent called finish_workflow. */
  finishedByAgent: boolean;
  /** Set when the agent called set_plan. `definition` is the workflow definition the call named. */
  plan: { definition: string } | null;
  /** How many tracker issue updates the step wrote, a move to started among them. */
  issueUpdates: number;
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
  /**
   * Set when a person pressed Stop while a model call of the author was in flight. `pageWrites`
   * names each page write the host took from the stop to the end of the step.
   */
  modelCallStopped: { task_id: string; pageWrites: string[] } | null;
  /**
   * Set when a restart or the deadline cut a model turn of the author. `prompt_id` is the queued
   * prompt a revise turn ran on, and null for a turn that produces the page.
   */
  modelTurnCut: { task_id: string; prompt_id: number | null } | null;
  /** Every comment the document host took during the step, oldest first. */
  pageCommentsPosted: PostedComment[];
  /** True when the document host refused every comment while a ruling landed on a page. */
  pageCommentsRefused: boolean;
  /** How many store statements the action ran. */
  work: number;
};

const FINISHED: TaskStatus[] = ["done", "failed", "cancelled"];

const JOB_ROLES: TaskRole[] = ["author", "researcher"];

const REFINER_ROLES: TaskRole[] = ["reviewer", "polisher"];

const FINISHED_WORKFLOW: WorkflowStatus[] = ["done", "failed", "cancelled"];

const ACTIVE_WORKFLOW: WorkflowStatus[] = ["running", "waiting_input"];

const RUNNING_AUTHOR: TaskStatus[] = ["queued", "provisioning", "working"];

const STARTING_AUTHOR: TaskStatus[] = ["queued", "provisioning"];

const ASKS_AND_FAILURES: TaskEvent["type"][] = [
  "question",
  "artifact_ready",
  "failed",
  "workflow_failed",
  "turn_failed",
];

const SESSION_MESSAGES: InboundEvent["kind"][] = ["prompt", "status"];

const FEED_CLOSINGS = ["response", "error"];

const ARTIFACT_MOVES: Array<[ArtifactStatus, ArtifactStatus]> = [
  ["drafted", "ready"],
  ["ready", "drafted"],
  ["drafted", "accepted"],
  ["ready", "accepted"],
  ["drafted", "removed"],
  ["ready", "removed"],
];

const coverDeliveredArtifact = coverageCase(
  "deliveredToHumansIsNeverCleared: an artifact the humans have",
);
const coverRefinerRunOnDelivered = coverageCase(
  "refinersRunAgainOnlyOnChangedRevision: a refiner run starts on an artifact the humans have",
);
const coverUnchangedTurnOnDelivered = coverageCase(
  "refinersRunAgainOnlyOnChangedRevision: an author turn ends on the revision the humans have",
);
const coverRunAfterRuling = coverageCase(
  "judgeRulesAtMostOnce: a refiner run starts after the judge ruled",
);
const coverRulingStands = coverageCase("judgeRulesAtMostOnce: a ruling stands into a later step");
const coverRejectionSent = coverageCase("judgeRulesAtMostOnce: an author got a judge's rejection");
const coverFeedback = coverageCase(
  "everyFeedbackGetsOneRoutingDecision: feedback on a running workflow",
);
const coverEventOnFinished = coverageCase(
  "nothingReopensAFinishedWorkflow: an event on a finished workflow",
);
const coverStopOnFinished = coverageCase(
  "nothingReopensAFinishedWorkflow: a stop on a finished workflow",
);
const coverOutsideAWorkflow = coverageCase(
  "sleepMessageOnlyDuringAWorkflow: an action outside a running workflow",
);
const coverSleepPosted = coverageCase("sleepMessageOnlyDuringAWorkflow: the sleep message posts");
const coverBeforePlan = coverageCase("workflowStartsOnlyFromAPlan: an action before the plan");
const coverEventBeforePlan = coverageCase(
  "workflowStartsOnlyFromAPlan: a person writes before the plan",
);
const coverPlanStarts = coverageCase("workflowStartsOnlyFromAPlan: a plan starts the workflow");
const coverChatIssue = coverageCase(
  "eachIssueLinksTheChatThreadOnce: a chat workflow works on an issue",
);
const coverChatTwoIssues = coverageCase(
  "eachIssueLinksTheChatThreadOnce: a chat workflow works on two issues",
);
const coverTrackerIssue = coverageCase(
  "eachIssueLinksTheChatThreadOnce: a tracker workflow works on an issue",
);
const coverBoard = coverageCase("boardsLiveOnlyInChat: a job has a board");
const coverJobWithoutChat = coverageCase("boardsLiveOnlyInChat: a job runs without a chat thread");
const coverTodoEntries = coverageCase("everyJobTaskIsOnItsBoard: a task shows its todo list");
const coverWorkLine = coverageCase("everyJobTaskIsOnItsBoard: a task shows its work line");
const coverResearcherOnBoard = coverageCase(
  "everyJobTaskIsOnItsBoard: a researcher is on its board",
);
const coverResearchHandedOn = coverageCase(
  "researchReadsCompleteOnceTheAuthorStarts: a researcher with a todo list hands on to its author",
);
const coverInReview = coverageCase("inReviewTaskHasAnArtifact: a task waits in review");
const coverRunDone = coverageCase("refinerRunIsDoneOnlyAfterItsTurnEnded: a refiner run ends done");
const coverPolisherDoneLater = coverageCase(
  "refinerRunIsDoneOnlyAfterItsTurnEnded: a polisher ends done in a later step",
);
const coverFinishedTask = coverageCase("finishedTaskKeepsItsStatus: a finished task in a step");
const coverTaskRestarted = coverageCase("taskRestartsAtMostTwice: a task restarted");
const coverPausedThroughAStep = coverageCase(
  "pausedAuthorGetsNoPrompt: a task stays paused through a step",
);
const coverPausedRestart = coverageCase(
  "pausedAuthorGetsNoPrompt: a paused task restarts in the step",
);
const coverWorkflowWaits = coverageCase(
  "workflowWaitsOnlyWhileNoAuthorWorks: the workflow moves to waiting for input",
);
const coverArtifactMove = coverageCase("artifactStatusMovesAreLegal: an artifact changes status");
const coverTodosAfterArtifact = coverageCase(
  "todoListIsFixedAfterFirstArtifact: an author with a todo list has an artifact",
);
const coverJobStarts = coverageCase("jobStartsOnlyIntoAFreeSlot: a job starts");
const coverLastSlot = coverageCase("jobStartsOnlyIntoAFreeSlot: a job starts into the last slot");
const coverWorkflowEnded = coverageCase(
  "endedWorkflowHasNoUnfinishedTask: a workflow ended with tasks",
);
const coverSharedInput = coverageCase("oneLiveJobPerInputArtifact: two jobs share an input");
const coverUnadmitted = coverageCase(
  "unadmittedFeedbackReachesNobody: feedback the screen did not admit",
);
const coverFailedCheck = coverageCase(
  "aFailedCheckNeverCompletesAJob: a check fails at completion",
);
const coverFailedCheckAsk = coverageCase(
  "aFailedCheckNeverAsksThePersonAgain: a check fails at completion",
);
const coverStaleAlarm = coverageCase("staleAlarmIsIgnored: a stale alarm fires");
const coverChatAndSessionPost = coverageCase(
  "orchestratorStaysOutOfSessionsWhenChatExists: a chat workflow with a session posts",
);
const coverTrackerPost = coverageCase(
  "linearOnlyAsksReachTheStartingSession: a workflow without a chat thread posts",
);
const coverTrackerAsk = coverageCase(
  "linearOnlyAsksReachTheStartingSession: a workflow without a chat thread asks or fails",
);
const coverSessionToRunning = coverageCase(
  "sessionMessageReachesItsRunningAuthorSilently: a person writes to a running author's session",
);
const coverSessionWithoutAuthor = coverageCase(
  "sessionMessageWithoutAnAuthorIsAnswered: a person writes to a session without a running author",
);
const coverCancelledTurnInSession = coverageCase(
  "stopEndsTheAuthorsTurn: a cancelled turn ends in a session",
);
const coverStop = coverageCase("stopEndsTheAuthorsTurn: a person presses Stop");
const coverStopOnAuthor = coverageCase("stopEndsTheAuthorsTurn: a stop reaches a session author");
const coverStopDuringTurn = coverageCase(
  "stopEndsTheAuthorsTurn: a stop lands during a running turn",
);
const coverStopOnIdle = coverageCase("stopEndsTheAuthorsTurn: a stop lands on an idle author");
const coverModelCallStopped = coverageCase(
  "stoppedModelCallLeavesThePage: a stop lands during a model call",
);
const coverTodosInChatWithSession = coverageCase(
  "chatWorkflowNeverSetsASessionPlan: a todo list changes in a chat workflow with a session",
);
const coverIdleInSession = coverageCase(
  "sessionFeedEndsWhenItsAuthorIdles: an author idles in a session",
);
const coverStreamStored = coverageCase("feedActivityPostsOnce: a streamed text is stored");
const coverWork = coverageCase("everyActionSettlesWithinItsWorkBudget: an action does work");
const coverModelCallAuthorQueued = coverageCase(
  "aQueuedPromptReachesItsModelCallAuthor: a model-call author has a queued prompt",
);
const coverModelCallAuthorWorking = coverageCase(
  "aModelCallAuthorWorksOnlyWhileItsCallIsOut: a model-call author works with no call out",
);
const coverModelTurnCut = coverageCase("aRestartDoesNotLoseAModelTurn: a model turn is cut");
const coverJudgeRejectsPage = coverageCase(
  "aJudgeRejectionPostsItsReasonOnce: a judge rejects a page",
);
const coverRejectionRefused = coverageCase(
  "aJudgeRejectionPostsItsReasonOnce: the host refuses the rejection comment",
);
const coverAccepted = coverageCase("anAcceptedArtifactNeverMovesBack: an artifact is accepted");
const coverTurnOnAccepted = coverageCase(
  "anAcceptedArtifactNeverMovesBack: an author turn ends on an accepted artifact",
);
const coverCompletedAgain = coverageCase(
  "anAcceptedArtifactNeverMovesBack: a job with an accepted artifact is completed again",
);

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
    coverDeliveredArtifact();
    if (artifactIn(step.after, before.job_id)?.delivered_to_humans_at == null) {
      violated("deliveredToHumansIsNeverCleared", `${before.job_id} lost delivered_to_humans_at`);
    }
  }
}

/**
 * A refiner run starts on an artifact the humans have only when an author turn ended on a
 * revision they have not seen. A host that cannot say the revision counts as a changed one.
 */
export function refinersRunAgainOnlyOnChangedRevision(workflow: WorkflowRuntime, step: Step): void {
  const turn = step.authorTurnEnd;
  if (turn && endsOnTheDeliveredRevision(workflow, step, turn)) coverUnchangedTurnOnDelivered();
  const known = new Set(step.before.tasks.map((task) => task.task_id));
  for (const run of step.after.tasks) {
    if (known.has(run.task_id) || !REFINER_ROLES.includes(run.role)) continue;
    const before = artifactIn(step.before, run.job_id);
    if (!before || before.status === "drafted") continue;
    coverRefinerRunOnDelivered();
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

/** True when an author turn ended on the revision the humans have, on a stage with refiners. */
function endsOnTheDeliveredRevision(
  workflow: WorkflowRuntime,
  step: Step,
  turn: NonNullable<Step["authorTurnEnd"]>,
): boolean {
  const author = step.before.tasks.find((task) => task.task_id === turn.task_id);
  const artifact = author && artifactIn(step.before, author.job_id);
  if (!author || !artifact || artifact.status === "drafted") return false;
  if (turn.hostRevision === null || turn.hostRevision !== artifact.delivered_revision) return false;
  const stage = workflow.stageFor(workflow.store.requireJob(author.job_id));
  return stage.reviewers.length + stage.polishers.length > 0;
}

/**
 * A judge entry rules at most once on an artifact, and its ruling never changes. An author that
 * got a rejection from a judge entry finds that entry's ruling stored as rejected.
 */
export function judgeRulesAtMostOnce(workflow: WorkflowRuntime, step: Step): void {
  const known = new Set(step.before.tasks.map((task) => task.task_id));
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
    const ruledBefore = ruled.some((run) => rulingBefore(step, run.task_id) != null);
    const runStarted = step.after.tasks.some(
      (run) =>
        run.job_id === author.job_id && REFINER_ROLES.includes(run.role) && !known.has(run.task_id),
    );
    if (ruledBefore && runStarted) coverRunAfterRuling();
    const indexes = ruled.map((run) => run.refiner_index);
    if (new Set(indexes).size !== indexes.length) {
      violated(
        "judgeRulesAtMostOnce",
        `${ruled.map((run) => run.task_id).join(", ")} ruled on one entry`,
      );
    }
    for (const run of ruled) {
      const earlier = rulingBefore(step, run.task_id);
      if (earlier != null) coverRulingStands();
      if (earlier != null && earlier !== run.ruling) {
        violated("judgeRulesAtMostOnce", `${run.task_id} went from ${earlier} to ${run.ruling}`);
      }
    }
    reviewers.forEach((entry, index) => {
      if (entry.mode !== "judge") return;
      const headline = rejectionHeadline(entry.name);
      if (!author.promptTexts.some((text) => text.startsWith(headline))) return;
      coverRejectionSent();
      const stored =
        workflow.store
          .refinerRunsOf(author.job_id)
          .map((run) => (run.refiner_index === index ? run.ruling : null))
          .find(judgeRuled)?.status ?? null;
      if (stored !== "rejected") {
        violated(
          "judgeRulesAtMostOnce",
          `${author.task_id} got a rejection from ${entry.name}, whose stored ruling is ${stored}`,
        );
      }
    });
  }
}

function rulingBefore(step: Step, taskId: string): string | null | undefined {
  return step.before.tasks.find((task) => task.task_id === taskId)?.ruling;
}

/**
 * Every feedback event on a running workflow gets exactly one routing decision: a prompt for the
 * author, a note that wakes the agent, or the note that it asks for nothing. Never silence, and
 * never two.
 */
export function everyFeedbackGetsOneRoutingDecision(_workflow: WorkflowRuntime, step: Step): void {
  if (!step.feedback || FINISHED_WORKFLOW.includes(step.before.workflowStatus)) return;
  coverFeedback();
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
  coverEventOnFinished();
  if (step.event.kind === "stop") coverStopOnFinished();
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

/** The sleep message posts only while a workflow is running. */
export function sleepMessageOnlyDuringAWorkflow(_workflow: WorkflowRuntime, step: Step): void {
  const { definition, workflowStatus } = step.before;
  const inAWorkflow = definition !== null && workflowStatus === "running";
  if (!inAWorkflow) coverOutsideAWorkflow();
  if (!step.postedTexts.includes(SLEEP_TEXT)) return;
  coverSleepPosted();
  if (inAWorkflow) return;
  violated(
    "sleepMessageOnlyDuringAWorkflow",
    `${step.action} posted the sleep message on a ${workflowStatus} workflow with workflow definition ${definition ?? "null"}`,
  );
}

/**
 * A workflow starts only when the agent sets a plan that names a workflow definition of the
 * deployment. Before that, a job does not start and the tracker issue does not move.
 */
export function workflowStartsOnlyFromAPlan(workflow: WorkflowRuntime, step: Step): void {
  const { definition } = step.after;
  if (step.before.definition === null) coverBeforePlan();
  if (step.before.definition === null && step.event?.person) coverEventBeforePlan();
  if (step.before.definition === null && definition !== null) {
    coverPlanStarts();
    const held = workflow.workflowDefinitions().some((declared) => declared.name === definition);
    if (step.plan?.definition !== definition || !held) {
      violated(
        "workflowStartsOnlyFromAPlan",
        `${step.action} started the workflow on workflow definition ${definition}`,
      );
    }
    return;
  }
  if (definition !== null) return;
  const changes = [
    step.after.tasks.length > 0 ? "a task exists" : null,
    step.issueUpdates > 0 ? "the tracker issue moved" : null,
    ACTIVE_WORKFLOW.includes(step.after.workflowStatus)
      ? `it is ${step.after.workflowStatus}`
      : null,
  ].filter((change) => change !== null);
  if (changes.length > 0) {
    violated(
      "workflowStartsOnlyFromAPlan",
      `after ${step.action}, ${changes.join(", ")} before the workflow started`,
    );
  }
}

/**
 * A job whose input is an issue names the subject issue or an issue in its scope. A start the tool
 * refused leaves the jobs unchanged.
 */
export function aJobWorksOnlyOnIssuesOfItsSubject(_workflow: WorkflowRuntime, step: Step): void {
  const { subject, jobs } = step.after;
  for (const job of jobs) {
    if (!job.issue_id || (subject && worldIssueInSubject(subject, job.issue_id))) continue;
    violated(
      "aJobWorksOnlyOnIssuesOfItsSubject",
      `after ${step.action}, ${job.job_id} works on ${job.issue_id} outside the subject ${describeSubject(subject)}`,
    );
  }
  if (step.start?.refused && jobs.length !== step.before.jobs.length) {
    violated("aJobWorksOnlyOnIssuesOfItsSubject", `${step.action} was refused and added a job`);
  }
}

/** The subject never changes once set. */
export function subjectNeverChanges(_workflow: WorkflowRuntime, step: Step): void {
  const { subject } = step.before;
  if (!subject || describeSubject(step.after.subject) === describeSubject(subject)) return;
  violated(
    "subjectNeverChanges",
    `${step.action} moved the subject from ${describeSubject(subject)} to ${describeSubject(step.after.subject)}`,
  );
}

/**
 * A single-issue workflow is done in the same step that a complete_job call completes the job on
 * its subject issue at the last planned stage. A workflow becomes done in no other step, except
 * one where the agent called finish_workflow, so a cancel or a failure of that job does not
 * complete it.
 */
export function aSingleIssueWorkflowIsDoneWithItsSubjectsJob(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const completesSubjectsJob = completedSubjectJobAtLastStage(step);
  const singleIssue = step.after.subject?.kind === "issue" && !step.after.plansIssues;
  if (completesSubjectsJob && singleIssue && step.after.workflowStatus !== "done") {
    violated(
      "aSingleIssueWorkflowIsDoneWithItsSubjectsJob",
      `${step.action} completed the job on the subject at the last stage, and the workflow is ${step.after.workflowStatus}`,
    );
  }
  const becameDone = step.before.workflowStatus !== "done" && step.after.workflowStatus === "done";
  if (becameDone && !step.finishedByAgent && !(completesSubjectsJob && singleIssue)) {
    violated(
      "aSingleIssueWorkflowIsDoneWithItsSubjectsJob",
      `${step.action} made the workflow done without completing the job on its subject issue`,
    );
  }
}

function completedSubjectJobAtLastStage(step: Step): boolean {
  const { completion } = step;
  const { subject } = step.after;
  if (!completion || subject?.kind !== "issue") return false;
  const before = step.before.tasks.find((task) => task.task_id === completion.task_id);
  const after = step.after.tasks.find((task) => task.task_id === completion.task_id);
  if (!after || after.status !== "done" || before?.status === "done") return false;
  const job = step.after.jobs.find((candidate) => candidate.job_id === after.job_id);
  return job?.issue_id === subject.issue_id && job.stage === step.after.lastStage;
}

function describeSubject(subject: Subject | null): string {
  if (!subject) return "none";
  return subject.kind === "issue" ? `issue ${subject.issue_id}` : `project ${subject.project_id}`;
}

/**
 * In a workflow that started from a chat thread, an issue subject and every issue a job works on
 * get exactly one link request to that thread. A workflow that started in the tracker sends none.
 */
export function eachIssueLinksTheChatThreadOnce(workflow: WorkflowRuntime): void {
  const linkedIssues = workflow.store
    .outbox()
    .filter((row) => row.kind === "attach_chat_thread")
    .map((row) => (row.target as { issue_id: string }).issue_id);
  const workedIssues = new Set(workflow.store.jobs().flatMap((job) => job.issue_id ?? []));
  if (workflow.state.origin?.source !== "chat") {
    if (workedIssues.size > 0) coverTrackerIssue();
    if (linkedIssues.length > 0) {
      violated("eachIssueLinksTheChatThreadOnce", `linked ${linkedIssues.join(", ")} without one`);
    }
    return;
  }
  const { subject } = workflow.state;
  if (subject?.kind === "issue") workedIssues.add(subject.issue_id);
  if (workedIssues.size > 0) coverChatIssue();
  if (workedIssues.size > 1) coverChatTwoIssues();
  for (const issue of workedIssues) {
    const links = occurrences(linkedIssues, issue);
    if (links !== 1) {
      violated("eachIssueLinksTheChatThreadOnce", `${issue} got ${links} link requests`);
    }
  }
  for (const issue of linkedIssues) {
    if (!workedIssues.has(issue)) {
      violated(
        "eachIssueLinksTheChatThreadOnce",
        `${issue} was linked without a job on it and is not the subject`,
      );
    }
  }
}

/** Every board lives in a chat thread the workflow replies to. A tracker session never holds one. */
export function boardsLiveOnlyInChat(workflow: WorkflowRuntime): void {
  const threads = new Set(
    workflow.state.reply_targets
      .filter((target) => target.source === "chat")
      .map((target) => channelKey(target)),
  );
  const jobs = workflow.store.jobs();
  if (threads.size === 0 && jobs.length > 0) coverJobWithoutChat();
  for (const job of jobs) {
    for (const board of workflow.store.boards(job.job_id)) {
      coverBoard();
      if (!threads.has(board.channel_key)) {
        violated("boardsLiveOnlyInChat", `${job.job_id} has a board at ${board.channel_key}`);
      }
    }
  }
}

/**
 * Each researcher and author of a job is on the job's board, as its todo list or its work line.
 * The work line is checked once the task is idle or done, or once an author's artifact exists.
 */
export function everyJobTaskIsOnItsBoard(workflow: WorkflowRuntime): void {
  for (const job of workflow.store.jobs()) {
    const lines = renderBoard(boardInputOf(workflow, job.job_id)).body.split("\n");
    const produced = workflow.store.artifact(job.job_id) !== null;
    for (const task of workflow.store.tasks()) {
      if (task.job_id !== job.job_id || !JOB_ROLES.includes(task.role)) continue;
      const entries = workflow.store.todoRow(task.task_id)?.todos?.entries ?? [];
      if (entries.length) coverTodoEntries();
      else coverWorkLine();
      if (task.role === "researcher") coverResearcherOnBoard();
      const missing = entries.length
        ? missingEntry(lines, entries)
        : missingLine(lines, expectedWorkLine(task.role, task.status, produced));
      if (missing !== null) {
        violated("everyJobTaskIsOnItsBoard", `${task.task_id} lacks "${missing}" on its board`);
      }
    }
  }
}

function missingEntry(lines: string[], entries: PlanEntry[]): string | null {
  const shown = entries.slice(0, BOARD_MAX_ENTRIES);
  return shown.find((entry) => !lines.some((line) => showsEntry(line, entry)))?.content ?? null;
}

function missingLine(lines: string[], expected: string): string | null {
  return lines.includes(expected) ? null : expected;
}

function showsEntry(line: string, entry: PlanEntry): boolean {
  const box = entry.status === "completed" ? "☑" : "☐";
  return line.startsWith(`${box} ${boardText(entry.content)}`);
}

function expectedWorkLine(role: TaskRole, status: TaskStatus, produced: boolean): string {
  const work = role === "researcher" ? "research" : "produce";
  const idle = status === "in_review" || status === "done";
  if (idle || (role === "author" && produced)) return `☑ ${work}`;
  return `☐ ${work} ← ${lifecycleLabel(status)}`;
}

/** Once a job's author exists, every entry of the todo list its researcher reported reads complete. */
export function researchReadsCompleteOnceTheAuthorStarts(workflow: WorkflowRuntime): void {
  for (const job of workflow.store.jobs()) {
    const researcher = workflow.store.researcherTask(job.job_id);
    if (!researcher || !workflow.store.authorTask(job.job_id)) continue;
    const entries = workflow.store.todoRow(researcher.task_id)?.todos?.entries ?? [];
    if (entries.length) coverResearchHandedOn();
    const open = entries.find((entry) => entry.status !== "completed");
    if (open) {
      violated(
        "researchReadsCompleteOnceTheAuthorStarts",
        `${researcher.task_id} still reads "${open.content}" ${open.status}`,
      );
    }
  }
}

/** A task cannot be `in_review` without an artifact on its job. */
export function inReviewTaskHasAnArtifact(workflow: WorkflowRuntime): void {
  for (const task of workflow.store.tasks()) {
    if (task.status !== "in_review") continue;
    coverInReview();
    if (!workflow.store.artifact(task.job_id)) {
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
    if (before?.status === "done") continue;
    coverRunDone();
    if (step.refinerTurnEnd?.task_id === after.task_id) continue;
    if (before?.role === "polisher" && before.quietSinceTurnEnd) {
      coverPolisherDoneLater();
      continue;
    }
    violated(
      "refinerRunIsDoneOnlyAfterItsTurnEnded",
      `${after.task_id} went from ${before?.status ?? "nothing"} to done with no turn end`,
    );
  }
}

/** A finished task never changes status again. */
export function finishedTaskKeepsItsStatus(_workflow: WorkflowRuntime, step: Step): void {
  for (const { before, after } of stepParts(step)) {
    for (const was of before.tasks) {
      if (!FINISHED.includes(was.status)) continue;
      coverFinishedTask();
      const now = after.tasks.find((task) => task.task_id === was.task_id);
      if (now?.status === was.status) continue;
      violated(
        "finishedTaskKeepsItsStatus",
        `${was.task_id} went from ${was.status} to ${now?.status ?? "nothing"}`,
      );
    }
  }
}

/** The step cut at each event that landed in the middle of its action, in order. */
function stepParts(step: Step): Array<{ before: Observation; after: Observation }> {
  const parts: Array<{ before: Observation; after: Observation }> = [];
  let before = step.before;
  for (const after of [...step.landed, step.after]) {
    parts.push({ before, after });
    before = after;
  }
  return parts;
}

/** A task restarts at most `MAX_RESTARTS` times, whatever the cause. */
export function taskRestartsAtMostTwice(workflow: WorkflowRuntime): void {
  for (const task of workflow.store.tasks()) {
    if (task.restarts > 0) coverTaskRestarted();
    if (task.restarts <= MAX_RESTARTS) continue;
    violated("taskRestartsAtMostTwice", `${task.task_id} restarted ${task.restarts} times`);
  }
}

/** A paused author or researcher does not get a prompt. */
export function pausedAuthorGetsNoPrompt(workflow: WorkflowRuntime, step: Step): void {
  for (const { before, after } of stepParts(step)) {
    for (const was of before.tasks) {
      const now = after.tasks.find((task) => task.task_id === was.task_id);
      if (!was.paused || !now?.paused) continue;
      coverPausedThroughAStep();
      if (workflow.store.requireTask(now.task_id).restarts > 0) coverPausedRestart();
      if (now.promptsSent === was.promptsSent) continue;
      violated(
        "pausedAuthorGetsNoPrompt",
        `${step.action} sent ${now.promptsSent - was.promptsSent} prompt(s) to paused ${now.task_id}`,
      );
    }
  }
}

/** The workflow moves to waiting for input only in a step that leaves no author or researcher at work. */
export function workflowWaitsOnlyWhileNoAuthorWorks(_workflow: WorkflowRuntime, step: Step): void {
  if (step.after.workflowStatus !== "waiting_input") return;
  if (step.before.workflowStatus === "waiting_input") return;
  coverWorkflowWaits();
  const working = step.after.tasks.filter(
    (task) => JOB_ROLES.includes(task.role) && RUNNING_AUTHOR.includes(task.status),
  );
  if (!working.length) return;
  violated(
    "workflowWaitsOnlyWhileNoAuthorWorks",
    `${step.action} moved the workflow to waiting_input while ${working.map((task) => `${task.task_id} (${task.status})`).join(", ")} worked`,
  );
}

/**
 * An artifact status moves only `drafted` to `ready`, `ready` to `drafted`, and either of them
 * to `accepted` or `removed`. `accepted` and `removed` are final.
 */
export function artifactStatusMovesAreLegal(_workflow: WorkflowRuntime, step: Step): void {
  for (const before of step.before.artifacts) {
    const after = artifactIn(step.after, before.job_id);
    if (after?.status === before.status) continue;
    coverArtifactMove();
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
    if (before !== undefined) coverTodosAfterArtifact();
    if (before !== after) {
      violated(
        "todoListIsFixedAfterFirstArtifact",
        `${author.task_id} todos went from ${before} to ${after}`,
      );
    }
  }
}

/**
 * A prompt queued for a model-call author reaches it. An unpaused model-call author with a queued
 * prompt has a model turn in flight, is starting, or a polisher holds its page.
 */
export function aQueuedPromptReachesItsModelCallAuthor(workflow: WorkflowRuntime): void {
  const queue = workflow.store.queue();
  for (const author of workflow.store.tasks()) {
    if (author.role !== "author" || FINISHED.includes(author.status)) continue;
    if (workflow.store.sandbox(author.task_id) || author.paused_at !== null) continue;
    const queued = queue.filter((row) => row.task_id === author.task_id).length;
    if (queued === 0) continue;
    coverModelCallAuthorQueued();
    if (taskAtWork(workflow, author)) continue;
    const polishing = workflow.store
      .tasks()
      .some(
        (run) =>
          run.role === "polisher" && run.job_id === author.job_id && !FINISHED.includes(run.status),
      );
    if (polishing) continue;
    violated(
      "aQueuedPromptReachesItsModelCallAuthor",
      `${author.task_id} is ${author.status} with ${queued} queued prompts and nothing takes them`,
    );
  }
}

/**
 * A model-call author is working only while a page model call of this instance is out for its
 * model turn, or after a stop ended its turn before its page existed.
 */
export function aModelCallAuthorWorksOnlyWhileItsCallIsOut(
  workflow: WorkflowRuntime,
  step: Step,
): void {
  for (const author of step.after.tasks) {
    if (author.role !== "author" || author.status !== "working") continue;
    if (workflow.store.sandbox(author.task_id) || author.modelCallOut) continue;
    coverModelCallAuthorWorking();
    const pageOut = workflow.store.artifact(author.job_id) !== null;
    if (!pageOut && !author.atWork) continue;
    violated(
      "aModelCallAuthorWorksOnlyWhileItsCallIsOut",
      `${author.task_id} is working with ${pageOut ? "its page out" : "a model turn"} and no call out`,
    );
  }
}

/**
 * A restart or the deadline does not lose a model turn. The author whose turn was cut is
 * starting, asks the page model again, is back in review with the prompt of its turn taken, waits
 * paused, or failed with a post to the person.
 */
export function aRestartDoesNotLoseAModelTurn(workflow: WorkflowRuntime, step: Step): void {
  const cut = step.modelTurnCut;
  if (!cut) return;
  coverModelTurnCut();
  const author = workflow.store.requireTask(cut.task_id);
  const observed = step.after.tasks.find((task) => task.task_id === cut.task_id);
  const promptTaken = !workflow.store.queue().some((row) => row.id === cut.prompt_id);
  const resumed =
    STARTING_AUTHOR.includes(author.status) ||
    observed?.modelCallOut === true ||
    (author.status === "in_review" && promptTaken) ||
    author.paused_at !== null ||
    (author.status === "failed" && step.postedTypes.includes("failed"));
  if (resumed) return;
  violated(
    "aRestartDoesNotLoseAModelTurn",
    `${cut.task_id} is ${author.status} after its model turn was cut`,
  );
}

/**
 * A job start leaves at most the plan's number of job slots of jobs active. The unfinished author
 * and researcher tasks count, and a refiner run takes no slot.
 */
export function jobStartsOnlyIntoAFreeSlot(workflow: WorkflowRuntime, step: Step): void {
  for (const { before, after } of stepParts(step)) {
    const knownJobs = new Set(before.tasks.map((task) => task.job_id));
    const started = after.tasks.filter((task) => !knownJobs.has(task.job_id));
    if (started.length === 0) continue;
    const activeBefore = before.tasks.filter(
      (task) => JOB_ROLES.includes(task.role) && !FINISHED.includes(task.status),
    ).length;
    const activeAfter = after.tasks.filter(
      (task) => JOB_ROLES.includes(task.role) && !FINISHED.includes(task.status),
    ).length;
    coverJobStarts();
    if (activeBefore > 0 && activeAfter === workflow.state.concurrency) coverLastSlot();
    if (activeAfter <= workflow.state.concurrency) continue;
    violated(
      "jobStartsOnlyIntoAFreeSlot",
      `${started.map((task) => task.job_id).join(", ")} started and left ${activeAfter} jobs active in ${workflow.state.concurrency} job slots`,
    );
  }
}

/** A workflow whose status is done, cancelled, or failed has no unfinished task. */
export function endedWorkflowHasNoUnfinishedTask(workflow: WorkflowRuntime): void {
  const { status } = workflow.state;
  if (!FINISHED_WORKFLOW.includes(status)) return;
  if (workflow.store.tasks().length > 0) coverWorkflowEnded();
  const unfinished = workflow.store.tasks().filter((task) => !FINISHED.includes(task.status));
  if (unfinished.length > 0) {
    violated(
      "endedWorkflowHasNoUnfinishedTask",
      `${unfinished.map((task) => `${task.task_id} (${task.status})`).join(", ")} in a ${status} workflow`,
    );
  }
}

/**
 * Only one live job works from each input artifact. An unfinished job holds its input. A finished
 * job holds it while its output exists, unless that output is the input itself.
 */
export function oneLiveJobPerInputArtifact(workflow: WorkflowRuntime): void {
  const owners = new Map<string, string>();
  const inputKeys = workflow.store.jobs().flatMap((job) => job.input_key ?? []);
  if (new Set(inputKeys).size < inputKeys.length) coverSharedInput();
  for (const job of workflow.store.jobs()) {
    const task = workflow.store.authorOrResearcherTaskOf(job.job_id);
    const output = workflow.store.artifact(job.job_id);
    const outputIsItsInput =
      output !== null &&
      artifactRefKey({ ref: output.ref, url: output.external_url }) === job.input_key;
    const outputHoldsInput = output !== null && output.status !== "removed" && !outputIsItsInput;
    const live = !FINISHED.includes(task.status) || outputHoldsInput;
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
  coverUnadmitted();
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
  coverFailedCheck();
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
  coverFailedCheckAsk();
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
  coverStaleAlarm();
  const { task_id } = step.staleAlarm;
  if (JSON.stringify(step.before) !== JSON.stringify(step.after)) {
    violated("staleAlarmIsIgnored", `a stale alarm of ${task_id} changed the workflow`);
  }
  if (step.notes.length > 0) {
    violated("staleAlarmIsIgnored", `a stale alarm of ${task_id} told the agent something`);
  }
}

/** The tracker session a person wrote the step's event in, or null. */
function sessionOfPerson(step: Step): string | null {
  const event = step.event;
  if (!event?.person || event.reply_to?.source !== "tracker") return null;
  return event.reply_to.session_id;
}

function sessionAuthorBefore(step: Step): ObservedTask | null {
  const session = sessionOfPerson(step);
  if (!session) return null;
  const authors = Object.entries(step.before.jobSessions)
    .filter(([, jobSession]) => jobSession === session)
    .flatMap(
      ([jobId]) =>
        step.before.tasks.find((task) => task.role === "author" && task.job_id === jobId) ?? [],
    );
  return authors.find((task) => !FINISHED.includes(task.status)) ?? authors.at(-1) ?? null;
}

function runningAuthorBefore(step: Step): ObservedTask | null {
  const author = sessionAuthorBefore(step);
  return author && RUNNING_AUTHOR.includes(author.status) ? author : null;
}

function queuedTextsOf(workflow: WorkflowRuntime, taskId: string): string[] {
  return workflow.store
    .queue()
    .filter((row) => row.task_id === taskId)
    .map((row) => row.text);
}

function occurrences(texts: string[], text: string): number {
  return texts.filter((candidate) => candidate === text).length;
}

/**
 * A judge rejection on a page posts its reason in one comment when the host takes it, and the
 * author gets the rejection whether the post landed or not.
 */
export function aJudgeRejectionPostsItsReasonOnce(workflow: WorkflowRuntime, step: Step): void {
  for (const run of step.after.tasks) {
    if (run.role !== "reviewer" || run.ruling === null || rulingBefore(step, run.task_id) != null) {
      continue;
    }
    const ruling = workflow.store.ruling(run.task_id);
    const ref = workflow.store.artifact(run.job_id)?.ref;
    if (ruling?.status !== "rejected" || ref?.kind !== "page") continue;
    coverJudgeRejectsPage();
    if (step.pageCommentsRefused) coverRejectionRefused();
    const posted = step.pageCommentsPosted.filter(
      (comment) =>
        comment.pageId === ref.page_id &&
        comment.passage === null &&
        comment.text.startsWith(ruling.reason),
    ).length;
    const expected = step.pageCommentsRefused ? 0 : 1;
    if (posted !== expected) {
      violated(
        "aJudgeRejectionPostsItsReasonOnce",
        `the rejection by ${run.task_id} posted ${posted} comments, not ${expected}`,
      );
    }
    const author = authorIn(step.after, run.job_id);
    if (!author || FINISHED.includes(author.status) || run.refiner_index === null) continue;
    const entry = workflow.stageFor(workflow.store.requireJob(run.job_id)).reviewers[
      run.refiner_index
    ];
    const headline = rejectionHeadline(entry?.name ?? "");
    const rejectionsBefore = (authorIn(step.before, run.job_id)?.promptsQueued ?? []).filter(
      (text) => text.startsWith(headline),
    ).length;
    const rejectionsAfter = author.promptsQueued.filter((text) => text.startsWith(headline)).length;
    if (rejectionsAfter <= rejectionsBefore) {
      violated(
        "aJudgeRejectionPostsItsReasonOnce",
        `${author.task_id} did not get the rejection by ${run.task_id}`,
      );
    }
  }
}

/** While a chat thread exists, the orchestrator posts nothing in a tracker session. */
export function orchestratorStaysOutOfSessionsWhenChatExists(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const sessions = [step.before.startingSession, ...Object.values(step.before.jobSessions)];
  const posted = step.postedTypes.length > 0 || step.feedPosts.length > 0;
  if (step.before.chatThread && sessions.some(Boolean) && posted) coverChatAndSessionPost();
  if (!step.before.chatThread || step.sessionPosts.length === 0) return;
  const posts = step.sessionPosts.map((post) => `${post.kind} in ${post.session_id}`);
  violated("orchestratorStaysOutOfSessionsWhenChatExists", `posted ${posts.join(", ")}`);
}

/**
 * In a workflow without a chat thread, the starting session gets every ask and failure notice
 * and nothing else. A session gets an answer only when a person wrote there.
 */
export function linearOnlyAsksReachTheStartingSession(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const starting = step.before.startingSession;
  if (step.before.chatThread || step.after.chatThread || !starting) return;
  const answered = sessionOfPerson(step);
  const asks = step.postedTypes.filter((type) => ASKS_AND_FAILURES.includes(type)).length;
  if (step.postedTypes.length > 0 || step.sessionPosts.length > 0) coverTrackerPost();
  if (asks > 0) coverTrackerAsk();
  const toStarting = step.sessionPosts.filter((post) => post.session_id === starting).length;
  if (toStarting < asks) {
    violated(
      "linearOnlyAsksReachTheStartingSession",
      `${asks} asks or failures posted and ${toStarting} reached the starting session`,
    );
  }
  if (answered !== starting && toStarting > asks) {
    violated(
      "linearOnlyAsksReachTheStartingSession",
      `${toStarting} posts reached the starting session for ${asks} asks or failures`,
    );
  }
  const elsewhere = step.sessionPosts.filter(
    (post) => post.session_id !== starting && post.session_id !== answered,
  );
  if (elsewhere.length > 0) {
    violated(
      "linearOnlyAsksReachTheStartingSession",
      `posted in ${elsewhere.map((post) => post.session_id).join(", ")}, where nobody wrote`,
    );
  }
}

/**
 * A person's message in a job session whose author runs goes to that author as a prompt. A prompt
 * that waits in the queue of an unpaused model-call author waits on an author at work. Nothing is
 * posted, and no agent turn wakes for it.
 */
export function sessionMessageReachesItsRunningAuthorSilently(
  workflow: WorkflowRuntime,
  step: Step,
): void {
  const event = step.event;
  if (!event || !SESSION_MESSAGES.includes(event.kind)) return;
  const author = runningAuthorBefore(step);
  if (!author) return;
  coverSessionToRunning();
  const after = step.after.tasks.find((task) => task.task_id === author.task_id);
  const held = occurrences(after?.promptTexts ?? [], event.text);
  if (held <= occurrences(author.promptTexts, event.text)) {
    violated(
      "sessionMessageReachesItsRunningAuthorSilently",
      `${author.task_id} did not get "${event.text}"`,
    );
  }
  const modelCall = workflow.store.sandbox(author.task_id) === null;
  const paused = workflow.store.requireTask(author.task_id).paused_at !== null;
  const waiting = occurrences(queuedTextsOf(workflow, author.task_id), event.text) > 0;
  if (
    modelCall &&
    !paused &&
    waiting &&
    after &&
    !after.atWork &&
    !FINISHED.includes(after.status)
  ) {
    violated(
      "sessionMessageReachesItsRunningAuthorSilently",
      `"${event.text}" waits on ${author.task_id}, which is ${after.status} and not at work`,
    );
  }
  if (step.after.posted !== step.before.posted) {
    violated("sessionMessageReachesItsRunningAuthorSilently", "the message got a post");
  }
  if (step.notes.some((note) => note.wake === "message")) {
    violated("sessionMessageReachesItsRunningAuthorSilently", "the message woke an agent turn");
  }
}

/**
 * A person's message in a session whose author does not run gets an answer: an agent turn wakes
 * for it, or code posts the reply in the chat thread, or in that session without a chat thread.
 */
export function sessionMessageWithoutAnAuthorIsAnswered(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const event = step.event;
  const session = sessionOfPerson(step);
  if (!event || !session || !SESSION_MESSAGES.includes(event.kind)) return;
  if (runningAuthorBefore(step)) return;
  coverSessionWithoutAuthor();
  if (step.notes.some((note) => note.wake === "message")) return;
  const posted = step.after.posted > step.before.posted;
  const reachedThem = step.after.chatThread
    ? posted
    : step.sessionPosts.some((post) => post.session_id === session);
  if (reachedThem) return;
  violated(
    "sessionMessageWithoutAnAuthorIsAnswered",
    `a ${event.kind} in ${session} got neither a turn nor a reply`,
  );
}

function endsOnTheStoppedReply(step: Step, taskId: string): boolean {
  const last = step.feedPosts.findLast((post) => post.task_id === taskId);
  return last?.kind === "response" && last.text === STOPPED_TEXT;
}

/**
 * A stop ends the author's turn and drops its queued prompts. Its session feed ends with the
 * stopped reply. The workflow status does not change, and the orchestrator does not post.
 */
export function stopEndsTheAuthorsTurn(_workflow: WorkflowRuntime, step: Step): void {
  const ended = step.authorTurnEnd;
  if (ended?.cancelled) {
    const author = step.after.tasks.find((task) => task.task_id === ended.task_id);
    const idle = author && !author.promptInFlight && author.queuedPrompts === 0;
    const inSession = author && step.after.jobSessions[author.job_id];
    if (idle && inSession) coverCancelledTurnInSession();
    if (idle && inSession && !endsOnTheStoppedReply(step, ended.task_id)) {
      violated("stopEndsTheAuthorsTurn", `the cancelled turn of ${ended.task_id} did not say so`);
    }
  }
  if (step.event?.kind !== "stop") return;
  coverStop();
  if (step.after.workflowStatus !== step.before.workflowStatus) {
    violated(
      "stopEndsTheAuthorsTurn",
      `the workflow went from ${step.before.workflowStatus} to ${step.after.workflowStatus}`,
    );
  }
  if (step.after.posted !== step.before.posted || step.sessionPosts.length > 0) {
    violated("stopEndsTheAuthorsTurn", "the orchestrator posted for the stop");
  }
  const author = sessionAuthorBefore(step);
  const after = author && step.after.tasks.find((task) => task.task_id === author.task_id);
  if (!author || !after) return;
  coverStopOnAuthor();
  if (author.turnRunning) coverStopDuringTurn();
  else if (!FINISHED.includes(author.status)) coverStopOnIdle();
  if (after.queuedPrompts > 0) {
    violated("stopEndsTheAuthorsTurn", `${author.task_id} kept ${after.queuedPrompts} prompts`);
  }
  if (author.turnRunning && after.cancelsSent === author.cancelsSent) {
    violated("stopEndsTheAuthorsTurn", `${author.task_id} was not sent a cancel`);
  }
  const resumes =
    after.promptInFlight || after.handshaking || STARTING_AUTHOR.includes(after.status);
  if (resumes && !FINISHED.includes(after.status)) {
    violated("stopEndsTheAuthorsTurn", `${author.task_id} would resume as ${after.status}`);
  }
  if (!endsOnTheStoppedReply(step, author.task_id)) {
    violated("stopEndsTheAuthorsTurn", `the session feed of ${author.task_id} did not say so`);
  }
}

/** A model call in flight when a person presses Stop does not change the page. */
export function stoppedModelCallLeavesThePage(_workflow: WorkflowRuntime, step: Step): void {
  const stopped = step.modelCallStopped;
  if (!stopped) return;
  coverModelCallStopped();
  if (stopped.pageWrites.length === 0) return;
  violated(
    "stoppedModelCallLeavesThePage",
    `${stopped.task_id} made ${stopped.pageWrites.join(", ")} after the stop`,
  );
}

/** While a chat thread exists, no tracker session gets a session plan. */
export function chatWorkflowNeverSetsASessionPlan(_workflow: WorkflowRuntime, step: Step): void {
  const sessions = [step.after.startingSession, ...Object.values(step.after.jobSessions)];
  const todosChanged = JSON.stringify(step.before.todos) !== JSON.stringify(step.after.todos);
  if (step.after.chatThread && sessions.some(Boolean) && todosChanged) {
    coverTodosInChatWithSession();
  }
  if (!step.after.chatThread || step.planPosts.length === 0) return;
  violated("chatWorkflowNeverSetsASessionPlan", `set a plan in ${step.planPosts.join(", ")}`);
}

/** A turn that leaves its author idle ends the author's session feed with a reply or an error. */
export function sessionFeedEndsWhenItsAuthorIdles(_workflow: WorkflowRuntime, step: Step): void {
  const ended = step.authorTurnEnd;
  if (!ended) return;
  const author = step.after.tasks.find((task) => task.task_id === ended.task_id);
  if (!author || FINISHED.includes(author.status)) return;
  if (author.promptInFlight || author.queuedPrompts > 0) return;
  if (!step.after.jobSessions[author.job_id]) return;
  coverIdleInSession();
  const last = step.feedPosts.findLast((post) => post.task_id === author.task_id);
  if (last && FEED_CLOSINGS.includes(last.kind)) return;
  violated(
    "sessionFeedEndsWhenItsAuthorIdles",
    `${author.task_id} went idle and its feed ended on ${last?.kind ?? "nothing"}`,
  );
}

/** The tracker holds at most one activity for each text an author streamed. */
export function feedActivityPostsOnce(_workflow: WorkflowRuntime, step: Step): void {
  if (step.streamedTexts.length > 0 && step.storedActivities.length > 0) coverStreamStored();
  for (const text of step.streamedTexts) {
    const holders = step.storedActivities.filter((stored) => stored.includes(text)).length;
    if (holders > 1) violated("feedActivityPostsOnce", `${holders} activities hold ${text}`);
  }
}

/**
 * Every action settles within its work budget. An action that runs more store statements than
 * the budget is a livelock, so the world stops it there.
 */
export function everyActionSettlesWithinItsWorkBudget(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  if (step.work > 0) coverWork();
  if (step.work > ACTION_WORK_BUDGET) exceededWorkBudget(step.action, step.work);
}

/**
 * An accepted artifact never moves back: it stays accepted, and no refiner run starts on its
 * job. Its job completes once: completing it again changes no task or artifact and posts nothing.
 */
export function anAcceptedArtifactNeverMovesBack(_workflow: WorkflowRuntime, step: Step): void {
  const known = new Set(step.before.tasks.map((task) => task.task_id));
  const endedTurn = step.before.tasks.find((task) => task.task_id === step.authorTurnEnd?.task_id);
  for (const before of step.before.artifacts) {
    if (before.status !== "accepted") continue;
    coverAccepted();
    if (endedTurn?.job_id === before.job_id) coverTurnOnAccepted();
    const after = artifactIn(step.after, before.job_id);
    if (after?.status !== "accepted") {
      violated(
        "anAcceptedArtifactNeverMovesBack",
        `${before.job_id} went from accepted to ${after?.status ?? "nothing"}`,
      );
    }
    const started = step.after.tasks.filter(
      (run) =>
        run.job_id === before.job_id && REFINER_ROLES.includes(run.role) && !known.has(run.task_id),
    );
    if (started.length) {
      violated(
        "anAcceptedArtifactNeverMovesBack",
        `${started.map((run) => run.task_id).join(", ")} started on the accepted artifact of ${before.job_id}`,
      );
    }
  }
  const completed = step.before.tasks.find((task) => task.task_id === step.completion?.task_id);
  if (completed?.status !== "done") return;
  if (artifactIn(step.before, completed.job_id)?.status !== "accepted") return;
  coverCompletedAgain();
  const changes = [
    JSON.stringify(step.before.tasks) !== JSON.stringify(step.after.tasks) ? "the tasks" : null,
    JSON.stringify(step.before.artifacts) !== JSON.stringify(step.after.artifacts)
      ? "the artifacts"
      : null,
    step.after.posted !== step.before.posted ? "the posts" : null,
  ].filter((change) => change !== null);
  if (changes.length > 0) {
    violated(
      "anAcceptedArtifactNeverMovesBack",
      `completing job ${completed.job_id} again changed ${changes.join(", ")}`,
    );
  }
}
