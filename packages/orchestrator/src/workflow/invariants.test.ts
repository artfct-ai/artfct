import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  aFailedCheckNeverAsksThePersonAgain,
  aFailedCheckNeverCompletesAJob,
  artifactStatusMovesAreLegal,
  authorIsIdleWhileAPolisherRuns,
  boardsLiveOnlyInChat,
  deliveredToHumansIsNeverCleared,
  endedWorkflowHasNoUnfinishedTask,
  everyFeedbackGetsOneRoutingDecision,
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
  sessionMessageReachesItsRunningAuthorSilently,
  sessionMessageWithoutAnAuthorIsAnswered,
  sessionStopReachesItsRunningAuthor,
  staleAlarmIsIgnored,
  todoListIsFixedAfterFirstArtifact,
  unadmittedFeedbackReachesNobody,
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
  agentSendsHeldComments,
  agentSetsPlan,
  agentStartsTask,
  agentStartsTaskOnArtifact,
  authorReportsTodos,
  authorTurnEnds,
  baseMoves,
  chatThreadJoins,
  checksReport,
  firstArtifactAppears,
  GENERATION_TIMERS,
  hostSays,
  personPostsFeedback,
  personPostsOnUnownedPull,
  personPressesStop,
  personRules,
  personSendsControl,
  personWrites,
  personWritesInSession,
  refinerRunFails,
  authorPromptFails,
  refinerRunPromptFails,
  refinerRunEnds,
  researcherTurnEnds,
  sandboxComesUp,
  sandboxGoesAway,
  staleAlarmFires,
  timePasses,
  timerFires,
  TIMERS,
  trackerOpensSession,
} from "../../test/workflow-actions";
import {
  MAX_AUTHORS,
  REFINER_SETUPS,
  REQUEST_TEXTS,
  WorkflowWorld,
  type WorkflowAction,
  type WorldSetup,
} from "../../test/workflow-world";

const NUM_RUNS = 200;
const MAX_ACTIONS = 50;
const TIMEOUT_MS = 120_000;

const STATE_INVARIANTS = [
  inReviewTaskHasAnArtifact,
  oneUnfinishedRefinerRunPerArtifact,
  authorIsIdleWhileAPolisherRuns,
  oneLiveJobPerInputArtifact,
  endedWorkflowHasNoUnfinishedTask,
  boardsLiveOnlyInChat,
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
  sessionStopReachesItsRunningAuthor,
];

const setups: fc.Arbitrary<WorldSetup> = fc.record({
  artifact: fc.constantFrom(
    "pull" as const,
    "pull" as const,
    "pull" as const,
    "issues" as const,
    "page" as const,
  ),
  refiners: fc.constantFrom(...REFINER_SETUPS),
  research: fc.boolean(),
  checksOnPush: fc.constantFrom("passed" as const, "reported_later" as const),
  pageEnding: fc.constantFrom("acceptance" as const, "choice" as const),
  origin: fc.constantFrom("chat" as const, "chat" as const, "tracker" as const, "tracker" as const),
});

const pageSetups: fc.Arbitrary<WorldSetup> = fc.record({
  artifact: fc.constant("page" as const),
  refiners: fc.constantFrom(...REFINER_SETUPS),
  research: fc.boolean(),
  checksOnPush: fc.constantFrom("passed" as const, "reported_later" as const),
  pageEnding: fc.constantFrom("acceptance" as const, "choice" as const),
  origin: fc.constantFrom("chat" as const, "chat" as const, "tracker" as const, "tracker" as const),
});

const author = fc.nat({ max: MAX_AUTHORS - 1 });

const PLANNED_STAGES = [["implement"], ["breakdown", "implement"], ["design", "plan", "breakdown"]];

const actions: fc.Arbitrary<WorkflowAction> = fc.oneof(
  {
    weight: 10,
    arbitrary: fc
      .tuple(
        author,
        fc.constantFrom("changed", "same", "unreadable"),
        fc.constantFrom("reports_work", "reports_work", "reports_work", "gives_up"),
      )
      .map(([index, revision, closing]) => authorTurnEnds(index, revision, closing)),
  },
  {
    weight: 6,
    arbitrary: fc
      .tuple(author, fc.constantFrom("written", "written", "written", "missing", "oversized"))
      .map(([index, payload]) => researcherTurnEnds(index, payload)),
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
      .tuple(fc.constantFrom(...PLANNED_STAGES), fc.integer({ min: 1, max: 3 }))
      .map(([stages, concurrency]) => agentSetsPlan(stages, concurrency)),
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
  { weight: 4, arbitrary: author.map(agentPromptsAuthor) },
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
    arbitrary: fc
      .tuple(author, fc.constantFrom("answers", "fails", "hangs"))
      .map(([index, decisions]) => agentSendsHeldComments(index, decisions)),
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
  judge: "approves",
  polisher: "nothing_pushed",
  stopReason: "end_turn",
  closing: "reports_work",
});

const abandonedArtifact = [firstArtifactAppears(0, "author_text"), agentCancels(0, "author")];

const openings: fc.Arbitrary<WorkflowAction[]> = fc.constantFrom(
  [],
  draftedArtifact,
  [...draftedArtifact, approvingEnd, approvingEnd, approvingEnd],
  abandonedArtifact,
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
      await fc.assert(property, { numRuns: NUM_RUNS });
      expect(STATE_INVARIANTS.length + STEP_INVARIANTS.length).toBe(25);
    },
    TIMEOUT_MS,
  );

  it(
    "hold after every action of any sequence, on a page stage of either ending",
    async () => {
      const property = fc.asyncProperty(pageSetups, sequences, holdsThroughout);
      await fc.assert(property, { numRuns: NUM_RUNS });
    },
    TIMEOUT_MS,
  );
});
