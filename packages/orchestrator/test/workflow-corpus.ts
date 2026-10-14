import {
  agentFinishesWorkflow,
  agentPromptsAuthor,
  authorTurnEnds,
  pageModelAnswers,
  personPressesStop,
  personSendsControl,
  personStopsModelCall,
  personWritesInSession,
  refinerRunFails,
  researcherTurnEnds,
  sandboxComesUp,
  sandboxGoesAway,
  timerFires,
  trackerOpensSession,
  type HeldCommentsRead,
} from "./workflow-actions";
import type { WorkflowAction, WorldSetup } from "./workflow-world";

/** One sequence a property shrank to when it found a bug, with the world it ran in. */
export type ReplayedSequence = [WorldSetup, WorkflowAction[]];

const MODEL_PAGE_ON_AN_ISSUE: WorldSetup = {
  opening: "job",
  artifact: "page",
  refiners: "none",
  research: false,
  pageAuthor: "model",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  origin: "tracker",
  firstInput: "origin_issue",
  sandboxStart: "on_an_action",
};

const RESEARCHED_MODEL_PAGE: WorldSetup = { ...MODEL_PAGE_ON_AN_ISSUE, research: true };

const HARNESS_PAGE_ON_AN_ISSUE: WorldSetup = { ...MODEL_PAGE_ON_AN_ISSUE, pageAuthor: "harness" };

const PULL_ON_AN_ISSUE: WorldSetup = { ...HARNESS_PAGE_ON_AN_ISSUE, artifact: "pull" };

const JUDGED_MODEL_PAGE_FROM_CHAT: WorldSetup = {
  ...MODEL_PAGE_ON_AN_ISSUE,
  refiners: "judge_between_reviewers",
  origin: "chat",
  firstInput: "request",
};

const HELD_COMMENTS_ADMITTED: HeldCommentsRead = {
  decisions: "answers",
  host: "readable",
  meanwhile: "nothing",
};

const cancelledWhileJudgedBlocked = authorTurnEnds(0, "changed", "blocked", "agent_cancels");

/**
 * Every shrunk sequence a workflow property found a bug with. Each property replays all of them
 * before its random runs, so a fixed bug stays fixed after the generator changes.
 */
export const WORKFLOW_CORPUS: ReplayedSequence[] = [
  [MODEL_PAGE_ON_AN_ISSUE, [personStopsModelCall(0, "agent_prompts")]],
  [MODEL_PAGE_ON_AN_ISSUE, [pageModelAnswers("throws"), personStopsModelCall(0, "agent_prompts")]],
  [MODEL_PAGE_ON_AN_ISSUE, [agentPromptsAuthor(0, HELD_COMMENTS_ADMITTED)]],
  [RESEARCHED_MODEL_PAGE, [researcherTurnEnds(0, "written"), sandboxComesUp("dials_in")]],
  [
    RESEARCHED_MODEL_PAGE,
    [
      researcherTurnEnds(0, "written"),
      personPressesStop(0),
      personWritesInSession(0, "question"),
    ],
  ],
  [
    PULL_ON_AN_ISSUE,
    [cancelledWhileJudgedBlocked, personSendsControl(0, "cancel"), personPressesStop(0)],
  ],
  [
    HARNESS_PAGE_ON_AN_ISSUE,
    [cancelledWhileJudgedBlocked, agentFinishesWorkflow(), personPressesStop(0)],
  ],
  [JUDGED_MODEL_PAGE_FROM_CHAT, [refinerRunFails(0), agentPromptsAuthor(0, HELD_COMMENTS_ADMITTED)]],
  [
    { ...HARNESS_PAGE_ON_AN_ISSUE, origin: "chat" },
    [sandboxGoesAway(0, "author"), timerFires("bridge_lost", 0), trackerOpensSession(0), personWritesInSession(0, "question")],
  ],
];
