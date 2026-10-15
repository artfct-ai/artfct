import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  aFailedCheckNeverAsksThePersonAgain,
  aFailedCheckNeverCompletesAJob,
  anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone,
  authorGetsEveryPageFinding,
  pageReviewPostsEachFindingOnce,
  artifactStatusMovesAreLegal,
  authorIsIdleWhileAPolisherRuns,
  boardsLiveOnlyInChat,
  chatWorkflowNeverSetsASessionPlan,
  deliveredToHumansIsNeverCleared,
  eachIssueLinksTheChatThreadOnce,
  endedWorkflowHasNoUnfinishedTask,
  everyFeedbackGetsOneRoutingDecision,
  everyJobTaskIsOnItsBoard,
  feedActivityPostsOnce,
  nothingReopensAFinishedWorkflow,
  refinerRunIsDoneOnlyAfterItsTurnEnded,
  finishedTaskKeepsItsStatus,
  inReviewTaskHasAnArtifact,
  jobStartsOnlyIntoAFreeSlot,
  judgeRulesAtMostOnce,
  linearOnlyAsksReachTheStartingSession,
  oneLiveJobPerInputArtifact,
  oneUnfinishedRefinerRunPerArtifact,
  orchestratorStaysOutOfSessionsWhenChatExists,
  refinersRunAgainOnlyOnChangedRevision,
  researchReadsCompleteOnceTheAuthorStarts,
  sessionMessageReachesItsRunningAuthorSilently,
  sessionMessageWithoutAnAuthorIsAnswered,
  sessionFeedEndsWhenItsAuthorIdles,
  stopEndsTheAuthorsTurn,
  stoppedModelCallLeavesThePage,
  staleAlarmIsIgnored,
  todoListIsFixedAfterFirstArtifact,
  sleepMessageOnlyDuringAWorkflow,
  unadmittedFeedbackReachesNobody,
  workflowKeepsItsDefinition,
  workflowStartsOnlyFromAPlan,
  aPromptToAPageAuthorCarriesItsHeldComments,
  anAcceptedArtifactNeverMovesBack,
  everyActionSettlesWithinItsWorkBudget,
  type Step,
  aQueuedPromptReachesItsModelCallAuthor,
  aModelCallAuthorWorksOnlyWhileItsCallIsOut,
  aRestartDoesNotLoseAModelTurn,
} from "../../test/invariants";
import { propertyRuns, propertySeed } from "../../test/property-runs";
import { declaredReachPoints, takeReachedPoints } from "../../test/reach";
import { WORKFLOW_CORPUS, type ReplayedSequence } from "../../test/workflow-corpus";
import {
  agentCancels,
  agentAdvancesStage,
  agentCompletes,
  agentCompletesWithSelection,
  agentFailsWorkflow,
  agentFinishesWorkflow,
  agentHoldsAuthor,
  agentPromptsAuthor,
  agentRoutes,
  agentSetsPlan,
  agentStartsTask,
  agentStartsTaskOnArtifact,
  authorReportsTodos,
  authorStreams,
  authorTurnEnds,
  baseMoves,
  chatThreadJoins,
  checksReport,
  firstArtifactAppears,
  GENERATION_TIMERS,
  pageModelAnswers,
  hostSays,
  personAsksForRevision,
  personCommentsOnPage,
  personPostsFeedback,
  personCancels,
  personPostsOnUnownedPull,
  personPressesStop,
  personStopsModelCall,
  personRules,
  personSendsControl,
  personWrites,
  personWritesInSession,
  refinerRunFails,
  authorPromptFails,
  refinerRunPromptFails,
  refinerRunEnds,
  researcherReportsTodos,
  type RefinerRunEnd,
  researcherTurnEnds,
  sandboxComesUp,
  sandboxGoesAway,
  staleAlarmFires,
  taskSandboxComesUp,
  timePasses,
  timerFires,
  TIMERS,
  trackerOpensSession,
  trackerTurns,
  workflowRestarts,
  workflowRestartsDuringModelCall,
  workflowRestartsWhileHostWritesPage,
  modelCallOutlivesItsDeadline,
  type HeldCommentsRead,
} from "../../test/workflow-actions";
import {
  MAX_AUTHORS,
  REFINER_SETUPS,
  REQUEST_TEXTS,
  SECOND_DEFINITION,
  WorkflowWorld,
  type WorkflowAction,
  type WorldSetup,
} from "../../test/workflow-world";
import { TEST_DEFINITION_NAME } from "../../test/test-config";

const RUNS = propertyRuns(200);
const REQUEST_RUNS = propertyRuns(50);
const MAX_ACTIONS = 50;
const TIMEOUT_MS = Math.max(120_000, RUNS * 600);
const FLOOR_RUNS = 1_000;
const FLOOR_SEED = 20_261_014;
const FLOOR_MIN_RUNS = 20;
const FLOOR_SHARE = 0.02;
const FLOOR_TIMEOUT_MS = 3_600_000;

const STATE_INVARIANTS = [
  aQueuedPromptReachesItsModelCallAuthor,
  inReviewTaskHasAnArtifact,
  oneUnfinishedRefinerRunPerArtifact,
  authorIsIdleWhileAPolisherRuns,
  oneLiveJobPerInputArtifact,
  endedWorkflowHasNoUnfinishedTask,
  boardsLiveOnlyInChat,
  eachIssueLinksTheChatThreadOnce,
  everyJobTaskIsOnItsBoard,
  researchReadsCompleteOnceTheAuthorStarts,
];

const STEP_INVARIANTS = [
  deliveredToHumansIsNeverCleared,
  refinersRunAgainOnlyOnChangedRevision,
  judgeRulesAtMostOnce,
  everyFeedbackGetsOneRoutingDecision,
  nothingReopensAFinishedWorkflow,
  refinerRunIsDoneOnlyAfterItsTurnEnded,
  finishedTaskKeepsItsStatus,
  artifactStatusMovesAreLegal,
  todoListIsFixedAfterFirstArtifact,
  staleAlarmIsIgnored,
  jobStartsOnlyIntoAFreeSlot,
  unadmittedFeedbackReachesNobody,
  aFailedCheckNeverCompletesAJob,
  aFailedCheckNeverAsksThePersonAgain,
  orchestratorStaysOutOfSessionsWhenChatExists,
  linearOnlyAsksReachTheStartingSession,
  sessionMessageReachesItsRunningAuthorSilently,
  sessionMessageWithoutAnAuthorIsAnswered,
  stopEndsTheAuthorsTurn,
  stoppedModelCallLeavesThePage,
  chatWorkflowNeverSetsASessionPlan,
  sessionFeedEndsWhenItsAuthorIdles,
  feedActivityPostsOnce,
  sleepMessageOnlyDuringAWorkflow,
  workflowStartsOnlyFromAPlan,
  workflowKeepsItsDefinition,
  anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone,
  aPromptToAPageAuthorCarriesItsHeldComments,
  pageReviewPostsEachFindingOnce,
  authorGetsEveryPageFinding,
  everyActionSettlesWithinItsWorkBudget,
  anAcceptedArtifactNeverMovesBack,
  aModelCallAuthorWorksOnlyWhileItsCallIsOut,
  aRestartDoesNotLoseAModelTurn,
];

const research = fc.constantFrom(false, false, false, true);

const sandboxStart = fc.constantFrom(
  "at_task_start" as const,
  "at_task_start" as const,
  "at_task_start" as const,
  "on_an_action" as const,
);

const jobSetups: fc.Arbitrary<WorldSetup> = fc.record({
  opening: fc.constant("job" as const),
  artifact: fc.constantFrom(
    "pull" as const,
    "pull" as const,
    "pull" as const,
    "issues" as const,
    "page" as const,
  ),
  refiners: fc.constantFrom(...REFINER_SETUPS),
  research,
  pageAuthor: fc.constant("harness" as const),
  checksOnPush: fc.constantFrom("passed" as const, "reported_later" as const),
  pageEnding: fc.constantFrom("acceptance" as const, "choice" as const),
  origin: fc.constantFrom("chat" as const, "chat" as const, "tracker" as const, "tracker" as const),
  firstInput: fc.constantFrom("request" as const, "origin_issue" as const, "origin_issue" as const),
  sandboxStart,
});

const requestSetups: fc.Arbitrary<WorldSetup> = jobSetups.map((setup) => ({
  ...setup,
  opening: "request" as const,
}));

const pageSetups: fc.Arbitrary<WorldSetup> = fc.record({
  opening: fc.constant("job" as const),
  artifact: fc.constant("page" as const),
  refiners: fc.constantFrom(...REFINER_SETUPS),
  research,
  pageAuthor: fc.constant("harness" as const),
  checksOnPush: fc.constantFrom("passed" as const, "reported_later" as const),
  pageEnding: fc.constantFrom("acceptance" as const, "choice" as const),
  origin: fc.constantFrom("chat" as const, "chat" as const, "tracker" as const, "tracker" as const),
  firstInput: fc.constantFrom("request" as const, "origin_issue" as const, "origin_issue" as const),
  sandboxStart,
});

const modelPageSetups: fc.Arbitrary<WorldSetup> = fc
  .tuple(pageSetups, fc.constantFrom("job" as const, "job" as const, "job_unstarted" as const))
  .map(([setup, worldOpening]) => ({
    ...setup,
    opening: worldOpening,
    pageAuthor: "model" as const,
  }));

const modelCallStart = fc.constantFrom(
  "provision_fires" as const,
  "agent_prompts" as const,
  "agent_prompts" as const,
  "revision_requested" as const,
);

const author = fc.nat({ max: MAX_AUTHORS - 1 });

const heldCommentsRead: fc.Arbitrary<HeldCommentsRead> = fc.record({
  decisions: fc.constantFrom(
    "answers" as const,
    "answers" as const,
    "fails" as const,
    "hangs" as const,
  ),
  host: fc.constantFrom("readable" as const, "readable" as const, "down" as const),
  meanwhile: fc.constantFrom("nothing" as const, "nothing" as const, "agent_cancels" as const),
});

const PLANNED_STAGES = [["implement"], ["breakdown", "implement"], ["design", "plan", "breakdown"]];

const PLANNED_DEFINITIONS = [
  TEST_DEFINITION_NAME,
  TEST_DEFINITION_NAME,
  TEST_DEFINITION_NAME,
  SECOND_DEFINITION,
  "triage",
];

const plans: fc.Arbitrary<WorkflowAction> = fc
  .tuple(
    fc.constantFrom(...PLANNED_DEFINITIONS),
    fc.option(fc.constantFrom(...PLANNED_STAGES), { freq: 3 }),
    fc.integer({ min: 1, max: 3 }),
  )
  .map(([definition, stages, concurrency]) => agentSetsPlan(definition, stages, concurrency));

const actions: fc.Arbitrary<WorkflowAction> = fc.oneof(
  {
    weight: 10,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("changed", "same", "unreadable"),
        fc.constantFrom(
          "finished",
          "finished",
          "finished",
          "waits_on_person",
          "blocked",
          "stopped_early",
          "stopped_early",
          "stopped_early",
          "decisions_fail",
          "decisions_hang",
          "silent",
        ),
        fc.constantFrom(
          "nothing",
          "nothing",
          "nothing",
          "nothing",
          "agent_prompts",
          "agent_cancels",
        ),
      )
      .map(([index, revision, closing, meanwhile]) =>
        authorTurnEnds(index, revision, closing, meanwhile),
      ),
  },
  {
    weight: 6,
    arbitrary: fc
      .tuple(author, fc.constantFrom("written", "written", "written", "missing", "oversized"))
      .map(([index, payload]) => researcherTurnEnds(index, payload)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(author, fc.integer({ min: 0, max: 3 }))
      .map(([index, completed]) => researcherReportsTodos(index, completed)),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("page", "page", "blank", "throws").map(pageModelAnswers),
  },
  {
    weight: 6,
    arbitrary: fc
      .tuple(author, fc.constantFrom("provision_fires", "agent_prompts"))
      .map(([index, start]) => personStopsModelCall(index, start)),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(author, modelCallStart)
      .map(([index, start]) => workflowRestartsDuringModelCall(index, start)),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(author, modelCallStart, fc.constantFrom("before" as const, "after" as const))
      .map(([index, start, applied]) => workflowRestartsWhileHostWritesPage(index, start, applied)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(author, modelCallStart)
      .map(([index, start]) => modelCallOutlivesItsDeadline(index, start)),
  },
  { weight: 3, arbitrary: author.map(refinerRunPromptFails) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(author, fc.constantFrom("changed", "same"))
      .map(([index, revision]) => authorPromptFails(index, revision)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(author, fc.constantFrom("author", "refiner_run"))
      .map(([index, target]) => sandboxGoesAway(index, target)),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(author, fc.constantFrom("author_text", "host_event"))
      .map(([index, via]) => firstArtifactAppears(index, via)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(author, fc.integer({ min: 0, max: 3 }))
      .map(([index, completed]) => authorReportsTodos(index, completed)),
  },
  {
    weight: 16,
    arbitrary: fc
      .tuple(
        author,
        fc.record({
          reviewer: fc.constantFrom("no_review", "approved", "findings", "blocking"),
          pageCommenting: fc.constantFrom(
            "takes" as const,
            "takes" as const,
            "drops_inline" as const,
            "inline_throws" as const,
            "down" as const,
          ),
          judge: fc.constantFrom(
            "approves",
            "rejects",
            "unclear",
            "no_conclusion",
            "decisions_fail",
          ),
          polisher: fc.constantFrom("pushed", "nothing_pushed"),
          stopReason: fc.constantFrom(
            "end_turn",
            "end_turn",
            "end_turn",
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
          ),
          closing: fc.constantFrom("reports_work", "reports_work", "reports_work", "gives_up"),
        }),
      )
      .map(([index, end]) => refinerRunEnds(index, end)),
  },
  { weight: 1, arbitrary: author.map(refinerRunFails) },
  {
    weight: 8,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("review", "review", "review_comment", "comment", "app_review"),
        fc.constantFrom(
          "for_author",
          "for_author",
          "for_author",
          "beyond_author",
          "asks_nothing",
          "unsure",
          "fails",
        ),
      )
      .map(([index, form, routing]) => personPostsFeedback(index, form, routing)),
  },
  { weight: 1, arbitrary: fc.constantFrom("review", "comment").map(personPostsOnUnownedPull) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("merged", "marked_ready", "marked_ready", "closed_unmerged", "reopened"),
      )
      .map(([index, word]) => hostSays(index, word)),
  },
  {
    weight: 10,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom(
          "unreported",
          "running",
          "running",
          "failed",
          "failed",
          "stopped",
          "passed_just_now",
          "passed_long_ago",
          "passed_long_ago",
        ),
        fc.constantFrom("delivered", "delivered", "delivered", "missed"),
      )
      .map(([index, report, webhook]) => checksReport(index, report, webhook)),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("clean", "clean", "conflicted", "conflicted", "unknown"),
        fc.constantFrom("delivered", "delivered", "delivered", "missed"),
      )
      .map(([index, mergeability, webhook]) => baseMoves(index, mergeability, webhook)),
  },
  { weight: 2, arbitrary: fc.constantFrom(2, 10, 180).map(timePasses) },
  {
    weight: 6,
    arbitrary: fc
      .tuple(author, fc.constantFrom("message", "message", "tool", "failed_tool"))
      .map(([index, streamed]) => authorStreams(index, streamed)),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom("up", "up", "fails_before_storing", "fails_after_storing")
      .map(trackerTurns),
  },
  { weight: 1, arbitrary: fc.constant(workflowRestarts()) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(author, fc.constantFrom("pause", "resume", "cancel", "instruct"))
      .map(([index, control]) => personSendsControl(index, control)),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("prompt", "prompt", "start", "status").map(personWrites),
  },
  { weight: 2, arbitrary: author.map(trackerOpensSession) },
  { weight: 1, arbitrary: fc.constantFrom("control", "word").map(personCancels) },
  {
    weight: 5,
    arbitrary: fc
      .tuple(
        fc.nat({ max: 3 }),
        fc.constantFrom("question", "question", "status", "pause", "cancel"),
      )
      .map(([index, said]) => personWritesInSession(index, said)),
  },
  { weight: 4, arbitrary: fc.nat({ max: 3 }).map(personPressesStop) },
  { weight: 1, arbitrary: fc.constant(chatThreadJoins()) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom("pull", "issues"),
        fc.constantFrom("an_issue", "a_taken_issue", "no_issue", "no_issue"),
        fc.constantFrom(...REQUEST_TEXTS),
      )
      .map(([kind, on, request]) => agentStartsTask(kind, on, request)),
  },
  { weight: 2, arbitrary: plans },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom("pull", "pull", "pull", "issues"),
        fc.constantFrom("a_finished_author", "a_finished_author", "any_author"),
        author,
      )
      .map(([kind, owner, index]) => agentStartsTaskOnArtifact(kind, owner, index)),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      agentFinishesWorkflow(),
      agentFinishesWorkflow(),
      agentFinishesWorkflow(),
      agentFailsWorkflow(),
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(author, fc.constantFrom("pause_task", "resume_task"))
      .map(([index, call]) => agentHoldsAuthor(index, call)),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(author, heldCommentsRead)
      .map(([index, read]) => agentPromptsAuthor(index, read)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(author, heldCommentsRead)
      .map(([index, read]) => personAsksForRevision(index, read)),
  },
  { weight: 2, arbitrary: fc.nat({ max: 999 }).map(personCommentsOnPage) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(author, fc.constantFrom("author", "refiner_run"))
      .map(([index, target]) => agentCancels(index, target)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("accepts", "accepts", "asks_for_a_change", "wrote_nothing"),
        fc.constantFrom("answers", "answers", "answers", "fails", "hangs"),
      )
      .map(([index, person, decisions]) => agentCompletes(index, person, decisions)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("accepts", "accepts", "asks_for_a_change", "wrote_nothing"),
        fc.constantFrom("answers", "answers", "fails", "hangs"),
      )
      .map(([index, person, decisions]) => agentCompletesWithSelection(index, person, decisions)),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("pull", "issues").map((next) => agentAdvancesStage(next)),
  },
  {
    weight: 5,
    arbitrary: fc
      .tuple(author, fc.constantFrom("request_review", "finish_review"))
      .map(([index, call]) => agentRoutes(index, call)),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(author, fc.constantFrom("approve", "reject"))
      .map(([index, ruling]) => personRules(index, ruling)),
  },
  {
    weight: 10,
    arbitrary: fc.constantFrom("dials_in", "dials_in", "stays_silent").map(sandboxComesUp),
  },
  {
    weight: 12,
    arbitrary: fc
      .tuple(fc.constantFrom(...TIMERS), fc.nat({ max: 3 }))
      .map(([timer, pick]) => timerFires(timer, pick)),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(fc.constantFrom(...GENERATION_TIMERS), fc.nat({ max: 5 }))
      .map(([timer, pick]) => staleAlarmFires(timer, pick)),
  },
);

const draftedArtifact = [firstArtifactAppears(0, "author_text"), authorTurnEnds(0, "same")];
const approvingEnd = refinerRunEnds(0, {
  reviewer: "approved",
  pageCommenting: "takes",
  judge: "approves",
  polisher: "nothing_pushed",
  stopReason: "end_turn",
  closing: "reports_work",
});

const findingsEnd = (pageCommenting: RefinerRunEnd["pageCommenting"]) =>
  refinerRunEnds(0, {
    reviewer: "findings",
    pageCommenting,
    judge: "rejects",
    polisher: "pushed",
    stopReason: "end_turn",
    closing: "reports_work",
  });

const reviewedOnAFlakyHost = [
  ...draftedArtifact,
  findingsEnd("drops_inline"),
  findingsEnd("takes"),
  findingsEnd("inline_throws"),
  findingsEnd("down"),
];

const stoppedEarly = authorTurnEnds(0, "same", "stopped_early");
const stoppedEarlySilently = authorTurnEnds(0, "same", "silent");
const freshSandboxDialsIn = sandboxComesUp("dials_in");

const authorKeepsStoppingEarly = [
  authorReportsTodos(0, 1),
  stoppedEarly,
  authorStreams(0, "tool"),
  stoppedEarly,
  authorStreams(0, "message"),
  stoppedEarly,
  freshSandboxDialsIn,
  authorTurnEnds(0, "same", "decisions_hang"),
  stoppedEarly,
  freshSandboxDialsIn,
  authorTurnEnds(0, "same", "decisions_fail"),
  stoppedEarlySilently,
];

const abandonedArtifact = [firstArtifactAppears(0, "author_text"), agentCancels(0, "author")];

const issueStartedAgain = [
  agentStartsTask("pull", "an_issue", REQUEST_TEXTS[0]),
  agentCancels(1, "author"),
  agentStartsTask("pull", "a_taken_issue", REQUEST_TEXTS[0]),
];

const deliveredThenUnchangedTurn = [
  ...draftedArtifact,
  approvingEnd,
  approvingEnd,
  approvingEnd,
  agentPromptsAuthor(0),
  authorTurnEnds(0, "same"),
];

const judgeApprovedThenAuthorPrompted = [
  ...draftedArtifact,
  approvingEnd,
  approvingEnd,
  approvingEnd,
  agentPromptsAuthor(0),
  authorTurnEnds(0, "changed"),
  approvingEnd,
  approvingEnd,
];

const polisherRunning = [
  ...draftedArtifact,
  approvingEnd,
  personPostsFeedback(0, "comment", "for_author"),
  agentPromptsAuthor(0),
];

const checksPass = checksReport(0, "passed_long_ago", "delivered");

const polishPushed = refinerRunEnds(0, {
  reviewer: "approved",
  pageCommenting: "takes",
  judge: "approves",
  polisher: "pushed",
  stopReason: "end_turn",
  closing: "reports_work",
});

const polisherWaitsOnChecks = [
  ...draftedArtifact,
  checksPass,
  polishPushed,
  polishPushed,
  checksPass,
];

const stopDuringRunningTurn = [trackerOpensSession(0), personPressesStop(0)];

const runningAuthorGetsSessionMessage = [
  trackerOpensSession(0),
  personWritesInSession(0, "question"),
];

const admittedHeldComments: HeldCommentsRead = {
  decisions: "answers",
  host: "readable",
  meanwhile: "nothing",
};

const heldCommentsOnDeliveredPage = [
  ...draftedArtifact,
  approvingEnd,
  approvingEnd,
  approvingEnd,
  personCommentsOnPage(1),
  agentPromptsAuthor(0, admittedHeldComments),
];

const modelCallStoppedMidWrite = [trackerOpensSession(0), personStopsModelCall(0, "agent_prompts")];

const twoIssuesInChat = [agentStartsTask("pull", "an_issue", REQUEST_TEXTS[1])];

const chatThreadWithTrackerSession = [chatThreadJoins(), trackerOpensSession(0)];

const acceptedArtifact = [
  ...draftedArtifact,
  approvingEnd,
  approvingEnd,
  approvingEnd,
  agentPromptsAuthor(0),
  hostSays(0, "merged"),
  authorTurnEnds(0, "same"),
  agentCompletes(0, "accepts", "answers"),
  agentCompletes(0, "accepts", "answers"),
];

type OpeningSetup = Partial<Pick<WorldSetup, "refiners" | "checksOnPush">>;

/** The actions a sequence starts with, and the refiners and checks they need to reach anything. */
type Opening = { setup: OpeningSetup; actions: WorkflowAction[] };

function opening(sequence: WorkflowAction[], setup: OpeningSetup = {}): Opening {
  return { setup, actions: sequence };
}

const openings: fc.Arbitrary<Opening> = fc.constantFrom(
  opening([]),
  opening(draftedArtifact),
  opening([...draftedArtifact, approvingEnd, approvingEnd, approvingEnd]),
  opening(reviewedOnAFlakyHost, { refiners: "reviewer" }),
  opening([...draftedArtifact, findingsEnd("down")], { refiners: "reviewer" }),
  opening(abandonedArtifact),
  opening(issueStartedAgain),
  opening(authorKeepsStoppingEarly),
  opening(deliveredThenUnchangedTurn, { refiners: "reviewer", checksOnPush: "passed" }),
  opening(deliveredThenUnchangedTurn, {
    refiners: "judge_then_polisher",
    checksOnPush: "passed",
  }),
  opening(judgeApprovedThenAuthorPrompted, {
    refiners: "judge_between_reviewers",
    checksOnPush: "passed",
  }),
  opening(polisherRunning),
  opening(polisherWaitsOnChecks, { refiners: "polisher", checksOnPush: "reported_later" }),
  opening(polisherWaitsOnChecks, {
    refiners: "reviewer_then_polisher",
    checksOnPush: "reported_later",
  }),
  opening(stopDuringRunningTurn),
  opening(runningAuthorGetsSessionMessage),
  opening(heldCommentsOnDeliveredPage),
  opening(modelCallStoppedMidWrite),
  opening(twoIssuesInChat),
  opening(chatThreadWithTrackerSession),
  opening(acceptedArtifact, { checksOnPush: "passed" }),
  opening(acceptedArtifact, { refiners: "polisher", checksOnPush: "passed" }),
);

const researchHandedOn = [researcherReportsTodos(0, 1), researcherTurnEnds(0, "written")];

const researchPrefaces: fc.Arbitrary<WorkflowAction[]> = fc.constantFrom(
  [],
  researchHandedOn,
  researchHandedOn,
);

const jobSequences: fc.Arbitrary<Opening> = fc
  .tuple(researchPrefaces, openings, fc.array(actions, { maxLength: MAX_ACTIONS, size: "max" }))
  .map(([preface, start, rest]) => opening([...preface, ...start.actions, ...rest], start.setup));

const requestSequences: fc.Arbitrary<Opening> = fc
  .array(fc.oneof({ weight: 10, arbitrary: actions }, { weight: 1, arbitrary: plans }), {
    maxLength: MAX_ACTIONS,
    size: "max",
  })
  .map((sequence) => opening(sequence));

async function checkedStep(world: WorkflowWorld, action: WorkflowAction): Promise<Step> {
  const step = await world.apply(action);
  for (const invariant of STATE_INVARIANTS) invariant(world.workflow);
  for (const invariant of STEP_INVARIANTS) invariant(world.workflow, step);
  return step;
}

function tasksStartedIn(world: WorkflowWorld, step: Step): string[] {
  const waitedBefore = new Set(
    step.before.tasks
      .filter((task) => task.status === "queued" || task.status === "provisioning")
      .map((task) => task.task_id),
  );
  return world
    .tasksAwaitingSandbox()
    .filter((task) => !waitedBefore.has(task.task_id))
    .map((task) => task.task_id);
}

async function holdsThroughout([setup, sequence]: ReplayedSequence): Promise<void> {
  const world = await WorkflowWorld.open(setup);
  for (const action of sequence) {
    const step = await checkedStep(world, action);
    if (setup.sandboxStart !== "at_task_start") continue;
    for (const taskId of tasksStartedIn(world, step)) {
      await checkedStep(world, taskSandboxComesUp(taskId));
    }
  }
}

function worldRuns(
  setups: fc.Arbitrary<WorldSetup>,
  sequences: fc.Arbitrary<Opening>,
): fc.Arbitrary<ReplayedSequence> {
  return fc
    .tuple(setups, sequences)
    .map(([setup, sequence]): ReplayedSequence => [
      { ...setup, ...sequence.setup },
      sequence.actions,
    ]);
}

const PROPERTIES = [
  { name: "on any refiner list", runs: worldRuns(jobSetups, jobSequences), numRuns: RUNS },
  {
    name: "on a page stage of either ending",
    runs: worldRuns(pageSetups, jobSequences),
    numRuns: RUNS,
  },
  {
    name: "on a page stage whose author is a model call",
    runs: worldRuns(modelPageSetups, jobSequences),
    numRuns: RUNS,
  },
  {
    name: "on a request before the plan",
    runs: worldRuns(requestSetups, requestSequences),
    numRuns: REQUEST_RUNS,
  },
];

const CORPUS_EXAMPLES = WORKFLOW_CORPUS.map((replayed): [ReplayedSequence] => [replayed]);

describe("the workflow invariants", () => {
  it("are every state and step invariant", () => {
    expect(STATE_INVARIANTS.length + STEP_INVARIANTS.length).toBe(44);
  });

  for (const property of PROPERTIES) {
    it(
      `hold after every action of any sequence, ${property.name}`,
      async () => {
        await fc.assert(fc.asyncProperty(property.runs, holdsThroughout), {
          numRuns: property.numRuns,
          seed: propertySeed(property.name),
          examples: CORPUS_EXAMPLES,
        });
      },
      TIMEOUT_MS,
    );
  }
});

async function reachedRunsOf(property: (typeof PROPERTIES)[number]): Promise<Map<string, number>> {
  const reachedRuns = new Map<string, number>();
  takeReachedPoints();
  const counted = fc.asyncProperty(property.runs, async (run) => {
    await holdsThroughout(run);
    for (const label of takeReachedPoints()) {
      reachedRuns.set(label, (reachedRuns.get(label) ?? 0) + 1);
    }
  });
  await fc.assert(counted, { numRuns: FLOOR_RUNS, seed: FLOOR_SEED });
  return reachedRuns;
}

describe.if(process.env.REACH_FLOOR === "1")("the reach floor", () => {
  it(
    "is met by some workflow property at every reach point",
    async () => {
      const floor = Math.max(FLOOR_MIN_RUNS, Math.ceil(FLOOR_RUNS * FLOOR_SHARE));
      const byProperty: Map<string, number>[] = [];
      for (const property of PROPERTIES) byProperty.push(await reachedRunsOf(property));
      const rows = declaredReachPoints().map((label) => {
        const runs = byProperty.map((reachedRuns) => reachedRuns.get(label) ?? 0);
        return { label, runs, best: Math.max(...runs) };
      });
      for (const row of rows) console.log(`${row.runs.join("\t")}\t${row.label}`);
      const below = rows.filter((row) => row.best < floor).map((row) => row.label);
      expect(below).toEqual([]);
    },
    FLOOR_TIMEOUT_MS,
  );
});
