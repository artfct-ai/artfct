import { describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
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
  aQueuedPromptReachesItsModelCallAuthor,
  aModelCallAuthorWorksOnlyWhileItsCallIsOut,
  aRestartDoesNotLoseAModelTurn,
} from "../../test/invariants";
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

const NUM_RUNS = 200;
const TIMEOUT_MS = propertyTimeoutMs(120_000, NUM_RUNS);
const MAX_ACTIONS = 50;

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
  aModelCallAuthorWorksOnlyWhileItsCallIsOut,
  aRestartDoesNotLoseAModelTurn,
];

const setups: fc.Arbitrary<WorldSetup> = fc.record({
  opening: fc.constantFrom("job" as const, "job" as const, "request" as const),
  artifact: fc.constantFrom(
    "pull" as const,
    "pull" as const,
    "pull" as const,
    "issues" as const,
    "page" as const,
  ),
  refiners: fc.constantFrom(...REFINER_SETUPS),
  research: fc.boolean(),
  pageAuthor: fc.constant("harness" as const),
  checksOnPush: fc.constantFrom("passed" as const, "reported_later" as const),
  pageEnding: fc.constantFrom("acceptance" as const, "choice" as const),
  origin: fc.constantFrom("chat" as const, "chat" as const, "tracker" as const, "tracker" as const),
  firstInput: fc.constantFrom("request" as const, "origin_issue" as const, "origin_issue" as const),
});

const pageSetups: fc.Arbitrary<WorldSetup> = fc.record({
  opening: fc.constant("job" as const),
  artifact: fc.constant("page" as const),
  refiners: fc.constantFrom(...REFINER_SETUPS),
  research: fc.boolean(),
  pageAuthor: fc.constant("harness" as const),
  checksOnPush: fc.constantFrom("passed" as const, "reported_later" as const),
  pageEnding: fc.constantFrom("acceptance" as const, "choice" as const),
  origin: fc.constantFrom("chat" as const, "chat" as const, "tracker" as const, "tracker" as const),
  firstInput: fc.constantFrom("request" as const, "origin_issue" as const, "origin_issue" as const),
});

const modelPageSetups: fc.Arbitrary<WorldSetup> = fc
  .tuple(pageSetups, fc.constantFrom("job" as const, "job" as const, "job_unstarted" as const))
  .map(([setup, opening]) => ({ ...setup, opening, pageAuthor: "model" as const }));

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
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...PLANNED_DEFINITIONS),
        fc.option(fc.constantFrom(...PLANNED_STAGES), { freq: 3 }),
        fc.integer({ min: 1, max: 3 }),
      )
      .map(([definition, stages, concurrency]) => agentSetsPlan(definition, stages, concurrency)),
  },
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

const openings: fc.Arbitrary<WorkflowAction[]> = fc.constantFrom(
  [],
  draftedArtifact,
  [...draftedArtifact, approvingEnd, approvingEnd, approvingEnd],
  reviewedOnAFlakyHost,
  abandonedArtifact,
  issueStartedAgain,
  authorKeepsStoppingEarly,
);

const sequences: fc.Arbitrary<WorkflowAction[]> = fc
  .tuple(openings, fc.array(actions, { maxLength: MAX_ACTIONS, size: "max" }))
  .map(([opening, rest]) => [...opening, ...rest]);

async function holdsThroughout(setup: WorldSetup, sequence: WorkflowAction[]): Promise<void> {
  const world = await WorkflowWorld.open(setup);
  for (const action of sequence) {
    const step = await world.apply(action);
    for (const invariant of STATE_INVARIANTS) invariant(world.workflow);
    for (const invariant of STEP_INVARIANTS) invariant(world.workflow, step);
  }
}

describe("the workflow invariants", () => {
  it(
    "hold after every action of any sequence, on any refiner list",
    async () => {
      const property = fc.asyncProperty(setups, sequences, holdsThroughout);
      await fc.assert(property, propertyRuns("workflow invariants on any refiner list", NUM_RUNS));
      expect(STATE_INVARIANTS.length + STEP_INVARIANTS.length).toBe(42);
    },
    TIMEOUT_MS,
  );

  it(
    "hold after every action of any sequence, on a page stage of either ending",
    async () => {
      const property = fc.asyncProperty(pageSetups, sequences, holdsThroughout);
      await fc.assert(property, propertyRuns("workflow invariants on a page stage", NUM_RUNS));
    },
    TIMEOUT_MS,
  );

  it(
    "hold after every action of any sequence, on a page stage whose author is a model call",
    async () => {
      const property = fc.asyncProperty(modelPageSetups, sequences, holdsThroughout);
      await fc.assert(
        property,
        propertyRuns("workflow invariants on a model page author", NUM_RUNS),
      );
    },
    TIMEOUT_MS,
  );
});
