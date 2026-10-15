import type { PostedComment } from "@artfct-ai/adapters/test/fake-documents";
import type { Control, InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ArtifactStatus, TaskStatus, WorkflowStatus } from "@artfct-ai/contracts/types";
import { ASK_WHETHER_ACCEPTED, ASK_WHICH_OPTION } from "../src/agent/tools/start/start";
import type { PlanEntry } from "@agentclientprotocol/sdk";
import { findingText, reviewLine } from "../src/artifact/review-text";
import type { Review } from "../src/artifact/types";
import { boardInputOf, channelKey } from "../src/workflow/board/board";
import {
  BOARD_MAX_ENTRIES,
  boardText,
  lifecycleLabel,
  renderBoard,
} from "../src/workflow/board/render";
import { SLEEP_TEXT } from "../src/workflow/lifecycle";
import type { TaskEvent, TaskRole } from "../src/workflow/task/events";
import type { Wake, WorkflowRuntime } from "../src/workflow/types";
import { STOPPED_TEXT } from "../src/workflow/feed/feed";
import { reachPoint } from "./reach";

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
  /** How many cancels its harness session was sent. */
  cancelsSent: number;
  promptInFlight: boolean;
  queuedPrompts: number;
  handshaking: boolean;
  /**
   * True when the latest turn of the author ended on its own with the work unfinished, and no
   * person stopped the author since.
   */
  stoppedEarly: boolean;
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
  /** The text of every comment the page host holds. */
  heldComments: string[];
};

/** One action and what an observer saw around it. */
export type Step = {
  action: string;
  before: Observation;
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
    control: Control | null;
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
  /** Set when the agent called set_plan. `definition` is the workflow definition the call named. */
  plan: { definition: string } | null;
  /** How many tracker issue updates the step wrote, a move to started among them. */
  issueUpdates: number;
  /** Set when the turn of a refiner run ended normally. */
  refinerTurnEnd: { task_id: string } | null;
  /**
   * Set when the turn of a findings reviewer of a page ended. `review` is what the run filed,
   * `comments` what the document host took during the step, and `hostUp` false when it took none.
   */
  pageReview: {
    task_id: string;
    review: Review | null;
    comments: PostedComment[];
    hostUp: boolean;
  } | null;
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
   * Set when the agent prompted the author of a page, or a person asked for a revision while an
   * author held a page. `authors` are those page authors. `expected` is `sent` when the host and
   * the screen let the held comments through, and `kept` when either held them back. `agentRead`
   * is what the agent read about it.
   */
  heldCommentsAsked: { authors: string[]; expected: "sent" | "kept"; agentRead: string } | null;
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

/** The most store statements one action may run. A settled action runs a few hundred at most. */
export const ACTION_WORK_BUDGET = 5_000;

const reachDeliveredArtifact = reachPoint(
  "deliveredToHumansIsNeverCleared: an artifact the humans have",
);
const reachRefinerRunOnDelivered = reachPoint(
  "refinersRunAgainOnlyOnChangedRevision: a refiner run starts on an artifact the humans have",
);
const reachUnchangedTurnOnDelivered = reachPoint(
  "refinersRunAgainOnlyOnChangedRevision: an author turn ends on the revision the humans have",
);
const reachRunAfterRuling = reachPoint(
  "judgeRulesAtMostOnce: a refiner run starts after the judge ruled",
);
const reachRulingStands = reachPoint("judgeRulesAtMostOnce: a ruling stands into a later step");
const reachFeedback = reachPoint(
  "everyFeedbackGetsOneRoutingDecision: feedback on a running workflow",
);
const reachEventOnFinished = reachPoint(
  "nothingReopensAFinishedWorkflow: an event on a finished workflow",
);
const reachStopOnFinished = reachPoint(
  "nothingReopensAFinishedWorkflow: a stop on a finished workflow",
);
const reachOutsideAWorkflow = reachPoint(
  "sleepMessageOnlyDuringAWorkflow: an action outside a running workflow",
);
const reachSleepPosted = reachPoint("sleepMessageOnlyDuringAWorkflow: the sleep message posts");
const reachBeforePlan = reachPoint("workflowStartsOnlyFromAPlan: an action before the plan");
const reachEventBeforePlan = reachPoint(
  "workflowStartsOnlyFromAPlan: a person writes before the plan",
);
const reachPlanStarts = reachPoint("workflowStartsOnlyFromAPlan: a plan starts the workflow");
const reachPlanOnStarted = reachPoint("workflowKeepsItsDefinition: a plan on a started workflow");
const reachChatIssue = reachPoint(
  "eachIssueLinksTheChatThreadOnce: a chat workflow works on an issue",
);
const reachChatTwoIssues = reachPoint(
  "eachIssueLinksTheChatThreadOnce: a chat workflow works on two issues",
);
const reachTrackerIssue = reachPoint(
  "eachIssueLinksTheChatThreadOnce: a tracker workflow works on an issue",
);
const reachBoard = reachPoint("boardsLiveOnlyInChat: a job has a board");
const reachJobWithoutChat = reachPoint("boardsLiveOnlyInChat: a job runs without a chat thread");
const reachTodoEntries = reachPoint("everyJobTaskIsOnItsBoard: a task shows its todo list");
const reachWorkLine = reachPoint("everyJobTaskIsOnItsBoard: a task shows its work line");
const reachResearcherOnBoard = reachPoint("everyJobTaskIsOnItsBoard: a researcher is on its board");
const reachResearchHandedOn = reachPoint(
  "researchReadsCompleteOnceTheAuthorStarts: a researcher with a todo list hands on to its author",
);
const reachInReview = reachPoint("inReviewTaskHasAnArtifact: a task waits in review");
const reachRunDone = reachPoint("refinerRunIsDoneOnlyAfterItsTurnEnded: a refiner run ends done");
const reachPolisherDoneLater = reachPoint(
  "refinerRunIsDoneOnlyAfterItsTurnEnded: a polisher ends done in a later step",
);
const reachFinishedTask = reachPoint("finishedTaskKeepsItsStatus: a finished task in a step");
const reachArtifactMove = reachPoint("artifactStatusMovesAreLegal: an artifact changes status");
const reachTodosAfterArtifact = reachPoint(
  "todoListIsFixedAfterFirstArtifact: an author with a todo list has an artifact",
);
const reachUnfinishedRun = reachPoint(
  "oneUnfinishedRefinerRunPerArtifact: an artifact has an unfinished refiner run",
);
const reachPolisherRuns = reachPoint("authorIsIdleWhileAPolisherRuns: a polisher runs");
const reachPolisherWithWaitingPrompt = reachPoint(
  "authorIsIdleWhileAPolisherRuns: a polisher runs while its author has a prompt waiting",
);
const reachJobStarts = reachPoint("jobStartsOnlyIntoAFreeSlot: a job starts");
const reachLastSlot = reachPoint("jobStartsOnlyIntoAFreeSlot: a job starts into the last slot");
const reachWorkflowEnded = reachPoint(
  "endedWorkflowHasNoUnfinishedTask: a workflow ended with tasks",
);
const reachSharedInput = reachPoint("oneLiveJobPerInputArtifact: two jobs share an input");
const reachUnadmitted = reachPoint(
  "unadmittedFeedbackReachesNobody: feedback the screen did not admit",
);
const reachFailedCheck = reachPoint("aFailedCheckNeverCompletesAJob: a check fails at completion");
const reachFailedCheckAsk = reachPoint(
  "aFailedCheckNeverAsksThePersonAgain: a check fails at completion",
);
const reachStaleAlarm = reachPoint("staleAlarmIsIgnored: a stale alarm fires");
const reachHeldSent = reachPoint(
  "aPromptToAPageAuthorCarriesItsHeldComments: held comments go to a running page author",
);
const reachHeldKept = reachPoint(
  "aPromptToAPageAuthorCarriesItsHeldComments: held comments stay held",
);
const reachChatAndSessionPost = reachPoint(
  "orchestratorStaysOutOfSessionsWhenChatExists: a chat workflow with a session posts",
);
const reachTrackerPost = reachPoint(
  "linearOnlyAsksReachTheStartingSession: a workflow without a chat thread posts",
);
const reachTrackerAsk = reachPoint(
  "linearOnlyAsksReachTheStartingSession: a workflow without a chat thread asks or fails",
);
const reachSessionToRunning = reachPoint(
  "sessionMessageReachesItsRunningAuthorSilently: a person writes to a running author's session",
);
const reachSessionWithoutAuthor = reachPoint(
  "sessionMessageWithoutAnAuthorIsAnswered: a person writes to a session without a running author",
);
const reachCancelledTurnInSession = reachPoint(
  "stopEndsTheAuthorsTurn: a cancelled turn ends in a session",
);
const reachStop = reachPoint("stopEndsTheAuthorsTurn: a person presses Stop");
const reachStopOnAuthor = reachPoint("stopEndsTheAuthorsTurn: a stop reaches a session author");
const reachStopDuringTurn = reachPoint(
  "stopEndsTheAuthorsTurn: a stop lands during a running turn",
);
const reachStopOnIdle = reachPoint("stopEndsTheAuthorsTurn: a stop lands on an idle author");
const reachModelCallStopped = reachPoint(
  "stoppedModelCallLeavesThePage: a stop lands during a model call",
);
const reachTodosInChatWithSession = reachPoint(
  "chatWorkflowNeverSetsASessionPlan: a todo list changes in a chat workflow with a session",
);
const reachIdleInSession = reachPoint(
  "sessionFeedEndsWhenItsAuthorIdles: an author idles in a session",
);
const reachStreamStored = reachPoint("feedActivityPostsOnce: a streamed text is stored");
const reachStoppedEarly = reachPoint(
  "anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone: an author stopped early",
);
const reachStoppedEarlyIdle = reachPoint(
  "anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone: an author stopped early without a prompt in flight",
);
const reachPageFindings = reachPoint(
  "pageReviewPostsEachFindingOnce: a page review files findings",
);
const reachPageReviewHostDown = reachPoint(
  "pageReviewPostsEachFindingOnce: a page review meets a host that is down",
);
const reachPageReviewMissing = reachPoint(
  "pageReviewPostsEachFindingOnce: a page reviewer ends without a review",
);
const reachPageFindingsPrompt = reachPoint(
  "authorGetsEveryPageFinding: a review prompt reaches the page author",
);
const reachWork = reachPoint("everyActionSettlesWithinItsWorkBudget: an action does work");
const reachAccepted = reachPoint("anAcceptedArtifactNeverMovesBack: an artifact is accepted");
const reachTurnOnAccepted = reachPoint(
  "anAcceptedArtifactNeverMovesBack: an author turn ends on an accepted artifact",
);
const reachCompletedAgain = reachPoint(
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
    reachDeliveredArtifact();
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
  if (turn && endsOnTheDeliveredRevision(workflow, step, turn)) reachUnchangedTurnOnDelivered();
  const known = new Set(step.before.tasks.map((task) => task.task_id));
  for (const run of step.after.tasks) {
    if (known.has(run.task_id) || !REFINER_ROLES.includes(run.role)) continue;
    const before = artifactIn(step.before, run.job_id);
    if (!before || before.status === "drafted") continue;
    reachRefinerRunOnDelivered();
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

/** A judge entry rules at most once on an artifact, and its ruling never changes. */
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
    if (ruledBefore && runStarted) reachRunAfterRuling();
    const indexes = ruled.map((run) => run.refiner_index);
    if (new Set(indexes).size !== indexes.length) {
      violated(
        "judgeRulesAtMostOnce",
        `${ruled.map((run) => run.task_id).join(", ")} ruled on one entry`,
      );
    }
    for (const run of ruled) {
      const earlier = rulingBefore(step, run.task_id);
      if (earlier != null) reachRulingStands();
      if (earlier != null && earlier !== run.ruling) {
        violated("judgeRulesAtMostOnce", `${run.task_id} went from ${earlier} to ${run.ruling}`);
      }
    }
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
  reachFeedback();
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
  reachEventOnFinished();
  if (step.event.kind === "stop") reachStopOnFinished();
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
  if (!inAWorkflow) reachOutsideAWorkflow();
  if (!step.postedTexts.includes(SLEEP_TEXT)) return;
  reachSleepPosted();
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
  if (step.before.definition === null) reachBeforePlan();
  if (step.before.definition === null && step.event?.person) reachEventBeforePlan();
  if (step.before.definition === null && definition !== null) {
    reachPlanStarts();
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

/** A later plan cannot change the workflow definition a workflow started with. */
export function workflowKeepsItsDefinition(_workflow: WorkflowRuntime, step: Step): void {
  const { definition } = step.before;
  if (definition !== null && step.plan) reachPlanOnStarted();
  if (definition === null || step.after.definition === definition) return;
  violated(
    "workflowKeepsItsDefinition",
    `${step.action} moved the workflow from ${definition} to ${step.after.definition ?? "null"}`,
  );
}

/**
 * In a workflow that started from a chat thread, every issue a job works on gets exactly one link
 * request to that thread. A workflow that started in the tracker sends none.
 */
export function eachIssueLinksTheChatThreadOnce(workflow: WorkflowRuntime): void {
  const linkedIssues = workflow.store
    .outbox()
    .filter((row) => row.kind === "attach_chat_thread")
    .map((row) => (row.target as { issue_id: string }).issue_id);
  const workedIssues = new Set(workflow.store.jobs().flatMap((job) => job.issue_id ?? []));
  if (workflow.state.origin?.source !== "chat") {
    if (workedIssues.size > 0) reachTrackerIssue();
    if (linkedIssues.length > 0) {
      violated("eachIssueLinksTheChatThreadOnce", `linked ${linkedIssues.join(", ")} without one`);
    }
    return;
  }
  if (workedIssues.size > 0) reachChatIssue();
  if (workedIssues.size > 1) reachChatTwoIssues();
  for (const issue of workedIssues) {
    const links = occurrences(linkedIssues, issue);
    if (links !== 1) {
      violated("eachIssueLinksTheChatThreadOnce", `${issue} got ${links} link requests`);
    }
  }
  for (const issue of linkedIssues) {
    if (!workedIssues.has(issue)) {
      violated("eachIssueLinksTheChatThreadOnce", `${issue} was linked without a job on it`);
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
  if (threads.size === 0 && jobs.length > 0) reachJobWithoutChat();
  for (const job of jobs) {
    for (const board of workflow.store.boards(job.job_id)) {
      reachBoard();
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
      if (entries.length) reachTodoEntries();
      else reachWorkLine();
      if (task.role === "researcher") reachResearcherOnBoard();
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
    if (entries.length) reachResearchHandedOn();
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
    reachInReview();
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
    reachRunDone();
    if (step.refinerTurnEnd?.task_id === after.task_id) continue;
    if (before?.role === "polisher" && before.quietSinceTurnEnd) {
      reachPolisherDoneLater();
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
  for (const before of step.before.tasks) {
    if (!FINISHED.includes(before.status)) continue;
    reachFinishedTask();
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
    reachArtifactMove();
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
    if (before !== undefined) reachTodosAfterArtifact();
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
    if (unfinished.length > 0) reachUnfinishedRun();
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
 * The author and a polisher never work at once. While a polisher run is unfinished, its author
 * does not have a prompt or a model call in flight.
 */
export function authorIsIdleWhileAPolisherRuns(workflow: WorkflowRuntime): void {
  for (const run of workflow.store.tasks()) {
    if (run.role !== "polisher" || FINISHED.includes(run.status)) continue;
    const author = workflow.store.authorTaskOf(run.job_id);
    reachPolisherRuns();
    if (workflow.store.queue().some((row) => row.task_id === author.task_id)) {
      reachPolisherWithWaitingPrompt();
    }
    const sandbox = workflow.store.sandbox(author.task_id);
    const busy = sandbox ? sandbox.prompt_in_flight === 1 : author.status === "working";
    if (busy) {
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
  reachJobStarts();
  if (unfinished.length > 0 && unfinished.length === workflow.state.concurrency - 1) {
    reachLastSlot();
  }
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
  if (workflow.store.tasks().length > 0) reachWorkflowEnded();
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
  const inputKeys = workflow.store.jobs().flatMap((job) => job.input_key ?? []);
  if (new Set(inputKeys).size < inputKeys.length) reachSharedInput();
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
  reachUnadmitted();
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
  reachFailedCheck();
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
  reachFailedCheckAsk();
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
  reachStaleAlarm();
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

function occurrences(texts: string[], text: string): number {
  return texts.filter((candidate) => candidate === text).length;
}

function promptsAddedTo(step: Step, taskId: string): string[] {
  const before = step.before.tasks.find((task) => task.task_id === taskId)?.promptTexts ?? [];
  const after = step.after.tasks.find((task) => task.task_id === taskId)?.promptTexts ?? [];
  return [...new Set(after)].filter((text) => occurrences(after, text) > occurrences(before, text));
}

/**
 * A prompt the agent sends to the author of a page, and a person's request for a revision, carry
 * every comment held on the page and mark it read. When the host cannot be read or the screen
 * does not admit them, no prompt carries them, they stay held, and the agent is told so. An
 * author that finished during the step is not owed them.
 */
export function aPromptToAPageAuthorCarriesItsHeldComments(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const asked = step.heldCommentsAsked;
  if (!asked || !step.before.heldComments.length) return;
  const running = asked.authors.filter((taskId) => {
    const task = step.after.tasks.find((candidate) => candidate.task_id === taskId);
    return task !== undefined && !FINISHED.includes(task.status);
  });
  if (!running.length) return;
  if (asked.expected === "sent") reachHeldSent();
  else reachHeldKept();
  const added = running.flatMap((taskId) => promptsAddedTo(step, taskId));
  for (const text of step.before.heldComments) {
    const reached = added.some((prompt) => prompt.includes(text));
    const stillHeld = step.after.heldComments.includes(text);
    if (asked.expected === "sent" && !reached) {
      violated("aPromptToAPageAuthorCarriesItsHeldComments", `"${text}" did not reach the author`);
    }
    if (asked.expected === "sent" && stillHeld) {
      violated("aPromptToAPageAuthorCarriesItsHeldComments", `"${text}" is still held`);
    }
    if (asked.expected === "kept" && reached) {
      violated("aPromptToAPageAuthorCarriesItsHeldComments", `"${text}" reached the author`);
    }
    if (asked.expected === "kept" && !stillHeld) {
      violated("aPromptToAPageAuthorCarriesItsHeldComments", `"${text}" was marked read`);
    }
    if (asked.expected === "kept" && asked.agentRead.includes(text)) {
      violated("aPromptToAPageAuthorCarriesItsHeldComments", `the agent read "${text}"`);
    }
    if (asked.expected === "kept" && !asked.agentRead.includes("They stay held.")) {
      violated("aPromptToAPageAuthorCarriesItsHeldComments", "the agent was not told");
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
  if (step.before.chatThread && sessions.some(Boolean) && posted) reachChatAndSessionPost();
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
  if (step.postedTypes.length > 0 || step.sessionPosts.length > 0) reachTrackerPost();
  if (asks > 0) reachTrackerAsk();
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
 * A person's message in a job session whose author runs goes to that author as a prompt. Nothing
 * is posted, and no agent turn wakes for it.
 */
export function sessionMessageReachesItsRunningAuthorSilently(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  const event = step.event;
  if (!event || !SESSION_MESSAGES.includes(event.kind)) return;
  const author = runningAuthorBefore(step);
  if (!author) return;
  reachSessionToRunning();
  const after = step.after.tasks.find((task) => task.task_id === author.task_id);
  const held = occurrences(after?.promptTexts ?? [], event.text);
  if (held <= occurrences(author.promptTexts, event.text)) {
    violated(
      "sessionMessageReachesItsRunningAuthorSilently",
      `${author.task_id} did not get "${event.text}"`,
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
  reachSessionWithoutAuthor();
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
    if (idle && inSession) reachCancelledTurnInSession();
    if (idle && inSession && !endsOnTheStoppedReply(step, ended.task_id)) {
      violated("stopEndsTheAuthorsTurn", `the cancelled turn of ${ended.task_id} did not say so`);
    }
  }
  if (step.event?.kind !== "stop") return;
  reachStop();
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
  reachStopOnAuthor();
  if (author.turnRunning) reachStopDuringTurn();
  else if (!FINISHED.includes(author.status)) reachStopOnIdle();
  if (after.queuedPrompts > 0) {
    violated("stopEndsTheAuthorsTurn", `${author.task_id} kept ${after.queuedPrompts} prompts`);
  }
  if (author.turnRunning) {
    if (after.cancelsSent > author.cancelsSent) return;
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
  reachModelCallStopped();
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
    reachTodosInChatWithSession();
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
  reachIdleInSession();
  const last = step.feedPosts.findLast((post) => post.task_id === author.task_id);
  if (last && FEED_CLOSINGS.includes(last.kind)) return;
  violated(
    "sessionFeedEndsWhenItsAuthorIdles",
    `${author.task_id} went idle and its feed ended on ${last?.kind ?? "nothing"}`,
  );
}

/** The tracker holds at most one activity for each text an author streamed. */
export function feedActivityPostsOnce(_workflow: WorkflowRuntime, step: Step): void {
  if (step.streamedTexts.length > 0 && step.storedActivities.length > 0) reachStreamStored();
  for (const text of step.streamedTexts) {
    const holders = step.storedActivities.filter((stored) => stored.includes(text)).length;
    if (holders > 1) violated("feedActivityPostsOnce", `${holders} activities hold ${text}`);
  }
}

/**
 * An idle author whose last turn stopped early is never left alone. It has a prompt queued or in
 * flight, such as its nudge, or it is restarting in a fresh sandbox, or its task finished.
 */
export function anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone(
  _workflow: WorkflowRuntime,
  step: Step,
): void {
  for (const author of step.after.tasks) {
    if (!author.stoppedEarly || FINISHED.includes(author.status)) continue;
    reachStoppedEarly();
    if (author.promptInFlight) continue;
    reachStoppedEarlyIdle();
    if (author.queuedPrompts > 0 || author.status === "provisioning" || author.handshaking)
      continue;
    violated(
      "anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone",
      `${author.task_id} stopped early and is idle with nothing queued, and it is not restarting`,
    );
  }
}

/**
 * PROPOSED, pending owner approval. When a page review reaches the document host, each finding
 * lands once, on its passage or in the outcome comment, and the outcome comment opens with the
 * review line. A turn that did not file a review does not post a comment.
 */
export function pageReviewPostsEachFindingOnce(_workflow: WorkflowRuntime, step: Step): void {
  const pageReview = step.pageReview;
  if (!pageReview) return;
  const { review, comments, hostUp } = pageReview;
  if (!hostUp) reachPageReviewHostDown();
  if (!review) {
    reachPageReviewMissing();
    if (comments.length) {
      violated("pageReviewPostsEachFindingOnce", `${comments.length} comments without a review`);
    }
    return;
  }
  if (review.findings.length) reachPageFindings();
  const outcomes = comments.filter((comment) => comment.passage === null);
  if (hostUp && outcomes.length !== 1) {
    violated("pageReviewPostsEachFindingOnce", `${outcomes.length} outcome comments`);
  }
  if (outcomes.some((comment) => !comment.text.startsWith(reviewLine(review)))) {
    violated(
      "pageReviewPostsEachFindingOnce",
      "an outcome comment does not open with the review line",
    );
  }
  for (const finding of review.findings) {
    const landed = comments.filter((comment) => comment.text.includes(findingText(finding))).length;
    if (landed > 1 || (hostUp && landed === 0)) {
      violated(
        "pageReviewPostsEachFindingOnce",
        `"${findingText(finding)}" landed ${landed} times`,
      );
    }
  }
}

/**
 * PROPOSED, pending owner approval. A review prompt the author of a page gets in the step its
 * reviewer ended carries every finding of that review with its passage, whatever the host took.
 */
export function authorGetsEveryPageFinding(_workflow: WorkflowRuntime, step: Step): void {
  const review = step.pageReview?.review;
  if (!review) return;
  const reviewer = step.after.tasks.find((task) => task.task_id === step.pageReview?.task_id);
  const author = step.after.tasks.find(
    (task) => task.role === "author" && task.job_id === reviewer?.job_id,
  );
  const newPrompts = author ? promptsAddedTo(step, author.task_id) : [];
  const reviewPrompts = newPrompts.filter((text) => text.includes("\nComments:\n"));
  if (reviewPrompts.length) reachPageFindingsPrompt();
  for (const prompt of reviewPrompts) {
    const missing = review.findings.find(
      (finding) => !prompt.includes(`- ${findingText(finding)}`),
    );
    if (missing) {
      violated("authorGetsEveryPageFinding", `the author was not told "${findingText(missing)}"`);
    }
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
  if (step.work > 0) reachWork();
  if (step.work > ACTION_WORK_BUDGET) exceededWorkBudget(step.action, step.work);
}

/** Stop an action that ran past its work budget. */
export function exceededWorkBudget(action: string, work: number): never {
  violated(
    "everyActionSettlesWithinItsWorkBudget",
    `${action} ran ${work} store statements, past the budget of ${ACTION_WORK_BUDGET}`,
  );
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
    reachAccepted();
    if (endedTurn?.job_id === before.job_id) reachTurnOnAccepted();
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
  reachCompletedAgain();
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
