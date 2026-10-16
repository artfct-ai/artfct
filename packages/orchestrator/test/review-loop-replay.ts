import { setSystemTime } from "bun:test";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import { FakeDecisions, type FakeAnswers } from "@artfct-ai/adapters/test/fake-decisions";
import type { DocumentsCommenting, FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { taskTools } from "../src/agent/tools/task";
import { labeledPageCommentIds } from "../src/artifact/page-comment-label";
import { findingText } from "../src/artifact/review-text";
import { CLOSING_TEXT_MARKER, replyMarker } from "../src/prompts/model-author-prompt";
import { sendHeldCommentsOnRevisionRequest } from "../src/workflow/refiner/held-comments";
import type { ArtifactRow, TaskRow } from "../src/workflow/store/tasks";
import { taskAtWork } from "../src/workflow/task/at-work";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import { JUDGE_CONCLUSION, MODEL_AUTHOR_MODEL } from "./fake-runtime";
import { HeldPageModel } from "./held-page-model";
import { InterleavedDecisions, onFirstCallAsking } from "./interleaved-decisions";
import { toolText } from "./tool-result";
import {
  agentCancels,
  agentPromptsAuthor,
  agentRoutes,
  authorTurnEnds,
  firstArtifactAppears,
  personRules,
  refinerRunEnds,
  refinerRunFails,
  type RefinerRunEnd,
} from "./workflow-actions";
import {
  HELD_COMMENT,
  PAGE_OPTION,
  pushCountOf,
  WorkflowWorld,
  type RefinerSetup,
  type WorkflowAction,
  type WorldAuthor,
  type WorldSetup,
} from "./workflow-world";

/** Who writes the artifact of a setup, and where. */
type SetupAuthor = "pull_harness" | "page_harness" | "page_model";

/** The setup modules of the review loop spec, with the refiner list and the author of each. */
export const SPEC_SETUPS = {
  judgeThenPolisher: { refiners: "judge_then_polisher", author: "pull_harness" },
  reviewerThenPolisher: { refiners: "reviewer_then_polisher", author: "pull_harness" },
  judgeBetweenReviewers: { refiners: "judge_between_reviewers", author: "pull_harness" },
  pageReviewerThenPolisher: { refiners: "reviewer_then_polisher", author: "page_harness" },
  pageJudgeBetweenReviewers: { refiners: "judge_between_reviewers", author: "page_harness" },
  modelCallAuthorWithTwoReviewers: {
    refiners: "two_reviewers_then_polisher",
    author: "page_model",
  },
} as const satisfies Record<string, { refiners: RefinerSetup; author: SetupAuthor }>;

/** The name of one setup module of the spec. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

const STEP_MS = 10 * 60_000;
const REPLAY_START = Date.parse("2026-01-01T00:00:00.000Z");

/** One refiner run as the spec sees it. */
type SpecRun = {
  refinerIndex: number;
  status: "Unfinished" | "Done" | "Cancelled" | "Failed";
  result:
    | { filed: "nothing" }
    | { filed: "review"; revision: number; findings: boolean }
    | { filed: "ruling"; ruling: "Approved" | "Rejected"; revision: number };
  restarts: number;
};

/** A comment code posted on the page for a refiner run, as the spec sees it. */
export type SpecReviewComment =
  | { kind: "inline"; run: number; passage: string }
  | { kind: "outcome"; run: number; findings: string[]; approves: boolean }
  | { kind: "rejection"; run: number };

/** A comment a person left on the page, as the spec sees it. */
export type SpecPersonComment = {
  commentThread: string;
  onTheBlock: boolean;
  mentions: boolean;
  acknowledged: boolean;
  gone: boolean;
  sent: boolean;
  answered: boolean;
};

/** The review of one artifact as the spec sees it. */
export type SpecReview = {
  author: {
    atWork: boolean;
    failed: boolean;
    queuedPrompts: number[][];
    turnComments: number[];
    pageEditsDuringTurn: string[];
    rejectedBy: number[];
    findingsFrom: number[];
  };
  artifact: {
    status: { status: "Drafted" } | { status: "Ready"; deliveredRevision: number };
    revision: number;
    refinerRun: number | null;
  };
  refinerRuns: SpecRun[];
  judgeRunsCodeRulesOn: number[];
  reviewComments: SpecReviewComment[];
  personComments: SpecPersonComment[];
};

/**
 * One state of a trace: the action that led to it, the judge run and review again decision it
 * picked, its other picks by name, what the agent read about held comments, and the review.
 */
export type TraceStep = {
  action: string;
  judgeRun: number | null;
  decision: ReviewAgainDecision | null;
  picks: Record<string, unknown>;
  agentHeard: string[];
  review: SpecReview;
};

const REVIEW_AGAIN_DECISIONS = ["ReviewAgain", "NoReviewAgain", "AgentRoutes"] as const;

/** What the review again decision says when a model-call author's turn ends. */
type ReviewAgainDecision = (typeof REVIEW_AGAIN_DECISIONS)[number];

/** Run the spec of one setup for `count` traces from `seed`, each checked against its invariants. */
export function generateTraces(setup: SpecSetup, count: number, seed: number): TraceStep[][] {
  return quintTraces({ spec: "review-loop", setup, count, steps: TRACE_STEPS, seed }).map((trace) =>
    traceSteps(setup, trace),
  );
}

function traceSteps(setup: SpecSetup, trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const picks = itfField(state, "mbt::nondetPicks");
    const picked = itfVariant(itfField(picks, "judgeRun", true));
    const decision = itfVariant(itfField(picks, "decision", true));
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      judgeRun: picked?.tag === "Some" ? itfInt(picked.value) : null,
      decision:
        decision?.tag === "Some"
          ? itfOneOf(itfText(itfField(decision.value, "tag")), REVIEW_AGAIN_DECISIONS)
          : null,
      picks: somePicks(picks),
      agentHeard: sortedTags(itfField(state, `${setup}::reviewLoop::agentHeard`)),
      review: specReview(itfField(state, `${setup}::reviewLoop::review`)),
    };
  });
}

function specReview(value: unknown): SpecReview {
  const author = itfField(value, "author");
  const artifact = itfField(value, "artifact");
  const status = itfVariant(itfField(artifact, "status"))!;
  const refinerRun = itfVariant(itfField(artifact, "refinerRun"))!;
  return {
    author: {
      atWork: itfBool(itfField(author, "atWork")),
      failed: itfBool(itfField(author, "failed")),
      queuedPrompts: itfList(itfField(author, "queuedPrompts")).map(sortedInts),
      turnComments: sortedInts(itfField(author, "turnComments")),
      pageEditsDuringTurn: sortedTags(itfField(author, "pageEditsDuringTurn")),
      rejectedBy: sortedInts(itfField(author, "rejectedBy")),
      findingsFrom: sortedInts(itfField(author, "findingsFrom")),
    },
    artifact: {
      status:
        status.tag === "Ready"
          ? {
              status: "Ready",
              deliveredRevision: itfInt(itfField(status.value, "deliveredRevision")),
            }
          : { status: "Drafted" },
      revision: itfInt(itfField(artifact, "revision")),
      refinerRun: refinerRun.tag === "OnRefinerRun" ? itfInt(refinerRun.value) : null,
    },
    refinerRuns: itfList(itfField(value, "refinerRuns")).map(specRun),
    judgeRunsCodeRulesOn: sortedInts(itfField(value, "judgeRunsCodeRulesOn")),
    reviewComments: itfList(itfField(value, "reviewComments")).map(specReviewComment),
    personComments: itfList(itfField(value, "personComments")).map(specPersonComment),
  };
}

function specReviewComment(value: unknown): SpecReviewComment {
  const comment = itfVariant(value)!;
  switch (comment.tag) {
    case "InlineFinding":
      return {
        kind: "inline",
        run: itfInt(itfField(comment.value, "refinerRun")),
        passage: itfVariant(itfField(comment.value, "passage"))!.tag,
      };
    case "OutcomeComment":
      return {
        kind: "outcome",
        run: itfInt(itfField(comment.value, "refinerRun")),
        findings: sortedTags(itfField(comment.value, "findings")),
        approves: itfBool(itfField(comment.value, "approves")),
      };
    case "RejectionComment":
      return { kind: "rejection", run: itfInt(comment.value) };
    default:
      throw new Error(`the trace has review comment ${comment.tag}`);
  }
}

function specPersonComment(value: unknown): SpecPersonComment {
  const commentThread = itfVariant(itfField(value, "commentThread"))!;
  const opened = commentThread.tag === "OpenedBy" ? "opened" : "review";
  return {
    commentThread: `${opened} ${itfInt(commentThread.value)}`,
    onTheBlock: itfBool(itfField(value, "onTheBlock")),
    mentions: itfBool(itfField(value, "mentions")),
    acknowledged: itfBool(itfField(value, "acknowledged")),
    gone: itfBool(itfField(value, "gone")),
    sent: itfBool(itfField(value, "sent")),
    answered: itfBool(itfField(value, "answered")),
  };
}

function somePicks(picks: unknown): Record<string, unknown> {
  if (typeof picks !== "object" || picks === null) return {};
  return Object.fromEntries(
    Object.entries(picks).flatMap(([name, picked]) => {
      const option = itfVariant(picked);
      return option?.tag === "Some" ? [[name, option.value]] : [];
    }),
  );
}

function sortedTags(set: unknown): string[] {
  return itfSet(set)
    .map((value) => itfVariant(value)!.tag)
    .toSorted();
}

function sortedInts(set: unknown): number[] {
  return itfSet(set)
    .map(itfInt)
    .toSorted((left, right) => left - right);
}

function specRun(value: unknown): SpecRun {
  const result = itfVariant(itfField(value, "result"))!;
  return {
    refinerIndex: itfInt(itfField(value, "refinerIndex")),
    status: itfOneOf(itfVariant(itfField(value, "status"))!.tag, RUN_STATUSES),
    result: specResult(result),
    restarts: itfInt(itfField(value, "restarts")),
  };
}

const RUN_STATUSES = ["Unfinished", "Done", "Cancelled", "Failed"] as const;
const RULINGS = ["Approved", "Rejected"] as const;

function specResult(result: { tag: string; value: unknown }): SpecRun["result"] {
  switch (result.tag) {
    case "FiledReview":
      return {
        filed: "review",
        revision: itfInt(itfField(result.value, "revision")),
        findings: itfBool(itfField(result.value, "findings")),
      };
    case "FiledRuling":
      return {
        filed: "ruling",
        ruling: itfOneOf(itfVariant(itfField(result.value, "ruling"))!.tag, RULINGS),
        revision: itfInt(itfField(result.value, "revision")),
      };
    default:
      return { filed: "nothing" };
  }
}

/** The ruling answers the decisions model gives a held conclusion. */
const RULING_PROBABILITIES = {
  decisionsModelApproves: 0.1,
  decisionsModelRejects: 0.9,
  decisionsModelCannotRule: 0.5,
} as const;

type RulingAction = keyof typeof RULING_PROBABILITIES;

const TURN_END: Omit<RefinerRunEnd, "reviewer" | "polisher" | "closing" | "pageCommenting"> = {
  judge: "approves",
  whileRuled: "nothing",
  stopReason: "end_turn",
};

const WORLD_ACTIONS: Record<string, WorkflowAction> = {
  authorTurnEndsOnANewRevision: authorTurnEnds(0, "changed", "finished"),
  authorTurnEndsOnTheSameRevision: authorTurnEnds(0, "same", "finished"),
  polisherPushes: refinerRunEnds(0, {
    ...TURN_END,
    pageCommenting: "takes",
    reviewer: "no_review",
    polisher: "pushed",
    closing: "reports_work",
  }),
  polisherPushesNothing: refinerRunEnds(0, {
    ...TURN_END,
    pageCommenting: "takes",
    reviewer: "no_review",
    polisher: "nothing_pushed",
    closing: "reports_work",
  }),
  refinerRunGivesUp: refinerRunEnds(0, {
    ...TURN_END,
    pageCommenting: "takes",
    reviewer: "no_review",
    polisher: "nothing_pushed",
    closing: "gives_up",
  }),
  agentRequestsReview: agentRoutes(0, "request_review"),
  agentFinishesReview: agentRoutes(0, "finish_review"),
  agentCancelsRefinerRun: agentCancels(0, "refiner_run"),
  refinerRunFails: refinerRunFails(0),
};

/** How the fake host takes the comments of a page review, for each spec commenting. */
const PAGE_COMMENTING: Record<string, DocumentsCommenting> = {
  TakesAll: "takes",
  DropsInline: "drops_inline",
  InlineThrows: "inline_throws",
  HostDown: "down",
};

/** A findings reviewer files `reviewer` on a host that takes comments the way `commenting` says. */
function findingsReviewerEnds(
  reviewer: "findings" | "approved",
  commenting: string,
): WorkflowAction {
  const pageCommenting = PAGE_COMMENTING[commenting];
  if (!pageCommenting) throw new Error(`the trace has commenting ${commenting}`);
  return refinerRunEnds(0, {
    ...TURN_END,
    pageCommenting,
    reviewer,
    polisher: "nothing_pushed",
    closing: "reports_work",
  });
}

/** A ruling call the decisions model holds, and the judge turn end that waits on it. */
type HeldRuling = { answer: (decisions: Decisions) => void; turnEnd: Promise<unknown> };

/** How the replay reads the revisions of the artifact. */
type ArtifactRevisions =
  | { kind: "pull" }
  | { kind: "page"; pageId: string; revisionAtOpen: number };

/** What the decisions model says to the review again question, for each spec decision. */
const REVIEW_AGAIN_ANSWERS: Record<ReviewAgainDecision, FakeAnswers> = {
  ReviewAgain: { review_again: 0.9 },
  NoReviewAgain: { review_again: 0.1 },
  AgentRoutes: new Error("the decisions model is down"),
};

/** What the decisions model says to the feedback route questions, for each spec route. */
const ROUTE_ANSWERS: Record<string, Record<string, number>> = {
  ToTheAuthor: { for_author: 0.9 },
  ToNobody: { for_author: 0.1 },
  ToTheAgent: { for_author: 0.5 },
};

/** A screen answer that quarantines the text it reads. */
const SCREEN_REFUSES = { takes_control: 0.9 };

/** The line of the page each part of it is, as the spec names the parts. */
const PAGE_PART_LINES: Record<string, number> = { Title: 0, Body: 2, TheBlock: 5 };

/** The line a passage of a page review quotes. No edit rewrites it. */
const QUOTED_PASSAGES: Record<string, string> = {
  "Keep one table": "QuotesThePage",
  "Merge the session rows": "QuotesMissingText",
};

/** Text each finding of a page review carries, by the passage the spec says it quotes. */
const FINDING_MARKERS: Record<string, string> = {
  QuotesThePage: "one table mixes two lifetimes",
  QuotesMissingText: "the page never says this",
  WithoutPassage: "the page names no metric",
};

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };

/** What a person asks in a comment that mentions the bot, named by the comment. */
function mentionBody(hostId: string): string {
  return `Tighten the summary (${hostId}).`;
}

/**
 * What the agent read in one step: the texts so far, how many tool results or events are still
 * out, the texts of the comments held when the step began, and what a mention in it asked.
 */
type HeardInStep = {
  step: number;
  texts: string[];
  pending: number;
  heldTexts: string[];
  mention: string | null;
  reported: boolean;
};

/** The page host methods a step can make fail. */
type FailingHostMethod =
  | "heldComments"
  | "acknowledgeComment"
  | "fetchComment"
  | "replyToComment"
  | "updatePageContent";

/** Where a person leaves a comment, as the spec picks it. */
type CommentPlace =
  | { place: "page" }
  | { place: "block" }
  | { place: "comment_thread"; of: number }
  | { place: "review"; of: number };

/** A person comment the replay put on the page, with what the spec says about where it sits. */
type ReplayComment = {
  hostId: string;
  commentThread: string;
  hostCommentThread: string;
  onTheBlock: boolean;
  mentions: boolean;
  lineId: number | null;
};

/** The comment every page of a world holds when the review starts. */
const COMMENT_HELD_AT_OPEN: ReplayComment = {
  hostId: HELD_COMMENT.id,
  commentThread: "opened 0",
  hostCommentThread: HELD_COMMENT.id,
  onTheBlock: false,
  mentions: false,
  lineId: null,
};

/**
 * Replays spec traces through a workflow world with one author. Each spec action maps to one
 * world action. A judge turn end stays open while the decisions model holds its ruling call,
 * until a later spec step answers it. A model-call author's turn stays open while the page model
 * holds its call, until a later spec step ends the turn. People comment on the page and edit it
 * on the fake host, and a step that the spec says the host fails swaps the failing host methods
 * in for that step.
 */
export class ReviewLoopReplay {
  readonly world: WorkflowWorld;
  private readonly author: WorldAuthor;
  private readonly revisions: ArtifactRevisions;
  private readonly pageModel: HeldPageModel | null;
  private readonly held = new Map<number, HeldRuling>();
  private readonly comments: ReplayComment[];
  private readonly pageLinesAtOpen: string[];
  private step = 0;
  private modelTurn: OpenModelTurn | null;
  private pageTextAtCall: string | null = null;
  private callsSeen = 0;
  private readonly heardSteps: HeardInStep[] = [];
  private heardNow: HeardInStep | null = null;

  private constructor(options: {
    world: WorkflowWorld;
    author: WorldAuthor;
    revisions: ArtifactRevisions;
    pageModel: HeldPageModel | null;
    modelTurn: OpenModelTurn | null;
  }) {
    this.world = options.world;
    this.author = options.author;
    this.revisions = options.revisions;
    this.pageModel = options.pageModel;
    this.modelTurn = options.modelTurn;
    const onPage = options.revisions.kind === "page";
    this.comments = onPage ? [COMMENT_HELD_AT_OPEN] : [];
    this.pageLinesAtOpen = onPage ? this.pageText().split("\n") : [];
    this.noteModelCall();
  }

  /** A world on the refiner list of `setup` whose author opened its artifact. */
  static async open(setup: SpecSetup): Promise<ReviewLoopReplay> {
    setSystemTime(new Date(REPLAY_START));
    const { refiners, author } = SPEC_SETUPS[setup];
    switch (author) {
      case "pull_harness":
        return ReviewLoopReplay.openPull(refiners);
      case "page_harness":
        return ReviewLoopReplay.openHarnessPage(refiners);
      case "page_model":
        return ReviewLoopReplay.openModelPage(refiners);
      default: {
        const unreachable: never = author;
        throw new Error(`unhandled author ${String(unreachable)}`);
      }
    }
  }

  private static async openPull(refiners: RefinerSetup): Promise<ReviewLoopReplay> {
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, refiners });
    await world.apply(firstArtifactAppears(0, "host_event"));
    return new ReviewLoopReplay({
      world,
      author: firstAuthorOf(world),
      revisions: { kind: "pull" },
      pageModel: null,
      modelTurn: null,
    });
  }

  private static async openHarnessPage(refiners: RefinerSetup): Promise<ReviewLoopReplay> {
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, refiners, artifact: "page" });
    await world.apply(firstArtifactAppears(0, "author_text"));
    const author = firstAuthorOf(world);
    const revisions = pageRevisionsOf(world, author);
    return new ReviewLoopReplay({ world, author, revisions, pageModel: null, modelTurn: null });
  }

  /**
   * The model-call author produces its page while the agent queues a prompt for it, so its first
   * revise turn is in flight on the page, the way the spec starts.
   */
  private static async openModelPage(refiners: RefinerSetup): Promise<ReviewLoopReplay> {
    const world = await WorkflowWorld.open({
      ...WORLD_SETUP,
      refiners,
      artifact: "page",
      pageAuthor: "model",
      opening: "job_unstarted",
    });
    const pageModel = new HeldPageModel();
    world.workflow.modelsByName[MODEL_AUTHOR_MODEL] = pageModel;
    const author = firstAuthorOf(world);
    const produceTurn = await untilModelCall(pageModel, () => world.startSandboxOf(author.taskId));
    await world.apply(agentPromptsAuthor(0));
    const modelTurn = await untilModelCall(pageModel, async () => {
      pageModel.answer(PRODUCED_PAGE_TEXT);
      await produceTurn?.work;
    });
    const revisions = pageRevisionsOf(world, author);
    return new ReviewLoopReplay({ world, author, revisions, pageModel, modelTurn });
  }

  /** Take one spec action, then bring up every sandbox that waits. */
  async take(step: TraceStep): Promise<void> {
    this.step += 1;
    setSystemTime(new Date(REPLAY_START + this.step * STEP_MS));
    this.world.workflow.gatewayInstance = new FakeGateway();
    const heard: HeardInStep = {
      step: this.step,
      texts: [],
      pending: 0,
      heldTexts:
        this.revisions.kind === "page"
          ? this.host()
              .heldNow()
              .map((held) => held.text)
          : [],
      mention: null,
      reported: false,
    };
    this.heardSteps.push(heard);
    this.heardNow = heard;
    const notesBefore = this.world.workflow.notes.length;
    await this.takeAction(step);
    for (const task of this.world.tasksAwaitingSandbox()) {
      await this.world.startSandboxOf(task.task_id);
    }
    this.noteModelCall();
    const otherMentions = this.heardSteps.flatMap((other) =>
      other !== heard && other.mention !== null ? [other.mention] : [],
    );
    const notes = this.world.workflow.notes
      .slice(notesBefore)
      .map((note) => note.text)
      .filter((note) => !otherMentions.some((mention) => note.includes(mention)));
    heard.texts.push(...notes);
  }

  /**
   * What the agent read about page comments in each step whose tool results and events have all
   * come back since the last call, as the spec names it. A step that prompts an idle model-call
   * author gets its tool result once the author's model call answers.
   */
  settledHeard(): Array<{ step: number; agentHeard: string[] }> {
    return this.heardSteps
      .filter((heard) => !heard.reported && heard.pending === 0)
      .map((heard) => {
        heard.reported = true;
        return { step: heard.step, agentHeard: agentHeardOf(heard.texts.join("\n"), heard) };
      });
  }

  /** The steps whose tool result or event has not come back. */
  unsettledSteps(): number[] {
    return this.heardSteps.filter((heard) => heard.pending > 0).map((heard) => heard.step);
  }

  /** Add what `reading` resolves to to what the agent read in the step that started it. */
  private async readInStep(reading: Promise<string[]>): Promise<void> {
    const heard = this.heardNow;
    if (!heard) throw new Error("no step is being taken");
    heard.pending += 1;
    try {
      heard.texts.push(...(await reading));
    } finally {
      heard.pending -= 1;
    }
  }

  private async takeAction(step: TraceStep): Promise<void> {
    const { action } = step;
    if (action === "judgeTurnEnds") return this.judgeTurnEnds();
    if (isRulingAction(action)) return this.answerRuling(action, step);
    if (action === "theHostFailsAModelCallAuthorsWrite") {
      return this.modelTurnEnds({
        part: pickTag(step, "part"),
        decision: "AgentRoutes",
        failure: pickTag(step, "failure"),
      });
    }
    if (this.pageModel && isAuthorTurnEnd(action)) {
      return this.modelTurnEnds({
        part: action === "authorTurnEndsOnANewRevision" ? pickTag(step, "part") : null,
        decision: step.decision,
        failure: null,
      });
    }
    switch (action) {
      case "agentPromptsAuthor":
        return this.whileHeldCommentsRead(step, {}, () => this.agentSendsAPrompt());
      case "personAsksForRevision":
        return this.whileHeldCommentsRead(step, {}, () => this.personAsksForRevision());
      case "personMentionsTheBot":
        return this.personMentionsTheBot(step);
      case "personCommentsOnThePage":
        return this.personComments(commentPlaceOf(pickOf(step, "place")));
      case "personEditsThePage":
        return this.personRewritesPage(pickTag(step, "part"));
      case "personApproves":
      case "personRejects":
        return this.untilModelCall(() =>
          this.world.apply(
            personRules(
              0,
              action === "personApproves" ? "approve" : "reject",
              pickTag(step, "post") === "HostTakes" ? "takes" : "down",
            ),
          ),
        );
      default: {
        const mapped = this.worldActionFor(step);
        await this.untilModelCall(() => this.world.apply(mapped));
      }
    }
  }

  /** Answer every held ruling call and model call, and put the clock back. */
  async close(): Promise<void> {
    for (const held of this.held.values()) {
      held.answer(new FakeDecisions(rulingAnswers(RULING_PROBABILITIES.decisionsModelCannotRule)));
      await held.turnEnd;
    }
    this.held.clear();
    if (this.pageModel && this.pageModel.heldUserText !== null) {
      await this.answerModelCall("The model gave up.");
    }
    setSystemTime();
  }

  /** The store and the page host as the spec sees them. */
  project(): SpecReview {
    const { store } = this.world.workflow;
    const author = this.world.taskOf(this.author);
    const artifact = this.world.artifactOf(this.author);
    if (!artifact) throw new Error("the author has no artifact");
    const runs = store.refinerRunsOf(author.job_id);
    const pointer = runs.findIndex((run) => run.task_id === artifact.refiner_task_id);
    const delivered = artifact.delivered_revision;
    const atWork = taskAtWork(this.world.workflow, author);
    const queued = store.queue().filter((row) => row.task_id === author.task_id);
    const turnAsked = this.pageModel && atWork ? this.pageModel.heldUserText : null;
    const revisionCount = (revision: string | null) => this.revisionCount(revision);
    return {
      author: {
        atWork,
        failed: author.status === "failed",
        queuedPrompts: (this.pageModel && atWork ? queued.slice(1) : queued).map((row) =>
          this.specCommentIdsIn(row.text),
        ),
        turnComments: turnAsked === null ? [] : this.specCommentIdsIn(turnAsked),
        pageEditsDuringTurn: turnAsked === null ? [] : this.pagePartsEditedSinceTheCall(),
        rejectedBy: this.judgeEntriesThatRejected(author, artifact),
        findingsFrom: this.runsWhoseFindingsReachedTheAuthor(author, runs),
      },
      artifact: {
        status:
          artifact.status === "drafted" || delivered === null
            ? { status: "Drafted" }
            : { status: "Ready", deliveredRevision: revisionCount(delivered) },
        revision: revisionCount(this.hostRevision()),
        refinerRun: pointer === -1 ? null : pointer,
      },
      refinerRuns: runs.map((run) => specRunOf(run, revisionCount)),
      judgeRunsCodeRulesOn: [...this.held.keys()].toSorted((left, right) => left - right),
      reviewComments: this.reviewComments(runs),
      personComments: this.comments.map((comment) => this.specPersonCommentOf(comment, author)),
    };
  }

  private worldActionFor(step: TraceStep): WorkflowAction {
    const { action } = step;
    if (action === "findingsReviewerLeavesFindings" || action === "findingsReviewerApproves") {
      const reviewer = action === "findingsReviewerLeavesFindings" ? "findings" : "approved";
      return findingsReviewerEnds(reviewer, pickTag(step, "commenting"));
    }
    if (this.revisions.kind === "page" && action === "authorTurnEndsOnANewRevision") {
      return this.afterPageEdit(
        pickTag(step, "part"),
        WORLD_ACTIONS.authorTurnEndsOnTheSameRevision!,
      );
    }
    if (this.revisions.kind === "page" && action === "polisherPushes") {
      return this.afterPageEdit(pickTag(step, "part"), WORLD_ACTIONS.polisherPushesNothing!);
    }
    const mapped = WORLD_ACTIONS[action];
    if (!mapped) throw new Error(`no world action for spec action ${action}`);
    return mapped;
  }

  /** The author or a polisher rewrites one part of the page on the host, then `action` runs. */
  private afterPageEdit(part: string, action: WorkflowAction): WorkflowAction {
    return {
      toString: () => `the page changes at ${part}, then ${String(action)}`,
      run: async (world) => {
        await this.editPage(part);
        return action.run(world);
      },
    };
  }

  /** Rewrite the line of `part` on the host, and keep the id of every other line. */
  private async editPage(part: string): Promise<void> {
    const before = this.pageText();
    await this.host().updatePageContent(this.requirePageId(), {
      before,
      after: this.withPartRewritten(before, part),
    });
  }

  /**
   * A person rewrites the whole line of `part` on the host, so a model-call author's write that
   * read the line before does not find it.
   */
  private async personRewritesPage(part: string): Promise<void> {
    const index = PAGE_PART_LINES[part];
    if (index === undefined) throw new Error(`the trace has page part ${part}`);
    const before = this.pageText();
    const lines = before.split("\n");
    lines[index] = `A person rewrote ${part} at step ${this.step}.`;
    await this.host().updatePageContent(this.requirePageId(), { before, after: lines.join("\n") });
  }

  private withPartRewritten(pageText: string, part: string): string {
    const index = PAGE_PART_LINES[part];
    if (index === undefined) throw new Error(`the trace has page part ${part}`);
    const lines = pageText.split("\n");
    lines[index] = `${this.pageLinesAtOpen[index]} (edit ${this.step})`;
    return lines.join("\n");
  }

  /** The agent sends the author a prompt of its own, and reads what the tool says. */
  private async agentSendsAPrompt(): Promise<void> {
    const { prompt_task } = taskTools(this.world.workflow);
    await this.untilModelCall(() =>
      this.readInStep(
        (async () => {
          const prompt = { task_id: this.author.taskId, text: "Add a test for it." };
          return [toolText(await prompt_task.execute(prompt, TOOL_CALL))];
        })(),
      ),
    );
  }

  /** A person tells the agent they finished reviewing, and the agent reads what was sent. */
  private async personAsksForRevision(): Promise<void> {
    await this.untilModelCall(() =>
      this.readInStep(
        sendHeldCommentsOnRevisionRequest(this.world.workflow).then((sent) => sent.notes),
      ),
    );
  }

  /** A person comments on the page and mentions the bot, and the host delivers the comment. */
  private async personMentionsTheBot(step: TraceStep): Promise<void> {
    const route = ROUTE_ANSWERS[pickTag(step, "route")];
    if (!route) throw new Error(`the trace has route ${pickTag(step, "route")}`);
    await this.whileHeldCommentsRead(step, route, async () => {
      const mention = this.addComment({ place: "page" }, true);
      const restore =
        pickTag(step, "lookup") === "TheHostCannotSay"
          ? this.failingHost("fetchComment", "the host cannot say who it mentions")
          : () => undefined;
      try {
        const asked = mentionBody(mention.hostId);
        if (this.heardNow) this.heardNow.mention = asked;
        await this.untilModelCall(() =>
          this.readInStep(
            this.deliverComment(mention, `@artfct ${asked}`).then(() => this.notesSaying(asked)),
          ),
        );
      } finally {
        restore();
      }
    });
  }

  /** The agent notes that carry `text`. */
  private notesSaying(asked: string): string[] {
    return this.world.workflow.notes
      .map((note) => note.text)
      .filter((note) => note.includes(asked));
  }

  /** A person comments on the page at `place` without a mention, and the host delivers it. */
  private async personComments(place: CommentPlace): Promise<void> {
    const comment = this.addComment(place, false);
    await this.untilModelCall(() => this.deliverComment(comment, this.commentText(comment)));
  }

  private async deliverComment(comment: ReplayComment, said: string): Promise<void> {
    const pageId = this.requirePageId();
    await this.world.deliver({
      kind: "feedback",
      text: said,
      bindings: [{ source: "documents_page", external_id: pageId }],
      page: { page_id: pageId, comment_id: comment.hostId },
    });
  }

  /** Put a person comment on the host at `place`, numbered the way the spec numbers it. */
  private addComment(place: CommentPlace, mentions: boolean): ReplayComment {
    const specId = this.comments.length;
    const hostId = `cmt-${specId}`;
    const comment = this.placedComment(place, specId, hostId, mentions);
    this.comments.push(comment);
    this.host().addPersonComment({
      id: hostId,
      pageId: this.requirePageId(),
      lineId: comment.lineId,
      authorName: "Bea",
      text: mentions ? `@artfct ${mentionBody(hostId)}` : this.commentText(comment),
      ...(comment.hostCommentThread === hostId
        ? {}
        : { commentThreadId: comment.hostCommentThread }),
      mentionsSelf: mentions,
    });
    return comment;
  }

  private placedComment(
    place: CommentPlace,
    specId: number,
    hostId: string,
    mentions: boolean,
  ): ReplayComment {
    const opened = {
      hostId,
      commentThread: `opened ${specId}`,
      hostCommentThread: hostId,
      onTheBlock: false,
      mentions,
      lineId: null,
    };
    switch (place.place) {
      case "page":
        return opened;
      case "block": {
        const lineId = this.host().lineIds(this.requirePageId())[PAGE_PART_LINES.TheBlock!];
        if (lineId === undefined) throw new Error("the page has no block");
        return { ...opened, onTheBlock: true, lineId };
      }
      case "comment_thread": {
        const earlier = this.comments[place.of];
        if (!earlier) throw new Error(`the trace replies to comment ${place.of}`);
        return { ...earlier, hostId, mentions };
      }
      case "review":
        return {
          ...opened,
          commentThread: `review ${place.of}`,
          hostCommentThread: `review-${place.of}`,
        };
      default: {
        const unreachable: never = place;
        throw new Error(`unhandled comment place ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private commentText(comment: ReplayComment): string {
    return `Comment ${comment.hostId}: cite the source.`;
  }

  /**
   * Run `body` while the held comments read the way the step says: the host cannot be read, the
   * screen quarantines them, or it admits them and their acknowledgement lands or fails. A person
   * may reply to the oldest held comment while the screen reads.
   */
  private async whileHeldCommentsRead(
    step: TraceStep,
    route: Record<string, number>,
    body: () => Promise<void>,
  ): Promise<void> {
    const read = pickTag(step, "read");
    const replyTo = this.oldestHeldComment();
    const answering = new FakeDecisions(
      read === "ScreenRefuses" ? { ...SCREEN_REFUSES, ...route } : route,
    );
    const replies = pickTag(step, "meanwhile") === "APersonReplies" && replyTo !== null;
    this.world.workflow.gatewayInstance = new FakeGateway({
      decisions: replies
        ? new InterleavedDecisions(
            answering,
            onFirstCallAsking("takes_control", async () => {
              this.addComment({ place: "comment_thread", of: replyTo }, false);
            }),
          )
        : answering,
    });
    const restore =
      read === "HostCannotBeRead"
        ? this.failingHost("heldComments", "the host cannot be read")
        : read === "AdmittedButAcknowledgementFails"
          ? this.failingHost("acknowledgeComment", "the host refuses the acknowledgement")
          : () => undefined;
    try {
      await body();
    } finally {
      restore();
    }
  }

  /** The held comment with the lowest spec number, or null when none is held. */
  private oldestHeldComment(): number | null {
    if (this.revisions.kind !== "page") return null;
    const held = this.host()
      .heldNow()
      .map((comment) => this.specCommentId(comment.id));
    return held.length ? Math.min(...held) : null;
  }

  /** Run `body` while the host takes or fails the comment of a judge rejection. */
  private async whileRejectionPosts(post: string, body: () => Promise<void>): Promise<void> {
    if (this.revisions.kind !== "page" || post === "HostTakes") return body();
    this.host().commenting = "down";
    try {
      await body();
    } finally {
      this.host().commenting = "takes";
    }
  }

  /** Make `method` of the page host fail until the returned function puts it back. */
  private failingHost(method: FailingHostMethod, reason: string): () => void {
    const host = this.host();
    const original = host[method];
    Object.assign(host, {
      [method]: async () => {
        throw new Error(`${method}: ${reason}`);
      },
    });
    return () => {
      Object.assign(host, { [method]: original });
    };
  }

  /** Make the page host apply a page text change and then fail the call. */
  private hostFailsAfterTheUpdate(): () => void {
    const host = this.host();
    const update = host.updatePageContent.bind(host);
    host.updatePageContent = async (pageId, change) => {
      await update(pageId, change);
      throw new Error("updatePageContent: the host lost the answer");
    };
    return () => {
      host.updatePageContent = update;
    };
  }

  /** Run `work`, and keep it as the open model turn when the page model takes a call meanwhile. */
  private async untilModelCall(work: () => Promise<unknown>): Promise<void> {
    if (!this.pageModel) {
      await work();
      return;
    }
    const opened = await untilModelCall(this.pageModel, work);
    if (opened) this.modelTurn = opened;
  }

  /** Keep the page text a new page model call read, for the edits that land while it is out. */
  private noteModelCall(): void {
    if (!this.pageModel || this.pageModel.calls === this.callsSeen) return;
    this.callsSeen = this.pageModel.calls;
    this.pageTextAtCall = this.pageText();
  }

  /** Answer the call the page model holds, then let the turn it ends run on. */
  private async answerModelCall(answer: string): Promise<void> {
    const pageModel = this.pageModel;
    if (!pageModel || pageModel.heldUserText === null) throw new Error("no page model call is out");
    const turn = this.modelTurn;
    this.modelTurn = null;
    await this.untilModelCall(async () => {
      pageModel.answer(answer);
      await turn?.work;
    });
  }

  /**
   * The model-call author's revise call answers with the page it read, with `part` rewritten when
   * it changed the page, and one comment reply per comment its prompt carries, in spec order. The
   * host takes its writes, or fails the one `failure` names.
   */
  private async modelTurnEnds(turnEnd: {
    part: string | null;
    decision: ReviewAgainDecision | null;
    failure: string | null;
  }): Promise<void> {
    const asked = this.pageModel?.heldUserText ?? null;
    const pageText = this.pageTextAtCall;
    if (asked === null || pageText === null) {
      throw new Error("the model-call author has no turn in flight");
    }
    if (!turnEnd.decision)
      throw new Error("the spec ended a model-call author's turn without a decision");
    const revised =
      turnEnd.part === null ? pageText : this.withPartRewritten(pageText, turnEnd.part);
    const replies = this.specCommentIdsIn(asked).flatMap((specId) => [
      replyMarker(this.comments[specId]!.hostId),
      "Answered on the page.",
    ]);
    const gatewayBefore = this.world.workflow.gatewayInstance;
    this.world.workflow.gatewayInstance = reviewAgainGateway(turnEnd.decision);
    const restore = this.hostFailing(turnEnd.failure);
    try {
      await this.answerModelCall(
        [revised, "", CLOSING_TEXT_MARKER, "Revised the page.", ...replies].join("\n"),
      );
    } finally {
      restore();
    }
    this.world.workflow.gatewayInstance = gatewayBefore;
  }

  private hostFailing(failure: string | null): () => void {
    switch (failure) {
      case null:
        return () => undefined;
      case "RepliesFail":
        return this.failingHost("replyToComment", "the host refuses the reply");
      case "UpdateFails":
        return this.failingHost("updatePageContent", "the host refuses the change");
      case "UpdateLandsThenFails":
        return this.hostFailsAfterTheUpdate();
      default:
        throw new Error(`the trace has host failure ${failure}`);
    }
  }

  private host(): FakeDocuments {
    return this.world.pageHost;
  }

  private pageText(): string {
    const pageText = this.host().pageText(this.requirePageId());
    if (pageText === undefined) throw new Error("the host does not hold the page");
    return pageText;
  }

  private requirePageId(): string {
    if (this.revisions.kind !== "page") throw new Error("the artifact is not a page");
    return this.revisions.pageId;
  }

  /** What the host says the artifact is now. */
  private hostRevision(): string | null {
    if (this.revisions.kind === "pull") return this.world.hostRevisionOf(this.author);
    return this.world.pageHost.pageRevision(this.revisions.pageId);
  }

  /** How often the artifact changed since the author opened it, as the spec counts revisions. */
  private revisionCount(revision: string | null): number {
    if (this.revisions.kind === "pull") return pushCountOf(revision ?? "");
    return Number(revision) - this.revisions.revisionAtOpen;
  }

  private specCommentId(hostId: string): number {
    const specId = this.comments.findIndex((comment) => comment.hostId === hostId);
    if (specId === -1) throw new Error(`the host holds comment ${hostId} the replay did not leave`);
    return specId;
  }

  /** The spec numbers of the page comments a prompt labels, lowest first. */
  private specCommentIdsIn(labeled: string): number[] {
    return labeledPageCommentIds(labeled)
      .map((hostId) => this.specCommentId(hostId))
      .toSorted((left, right) => left - right);
  }

  /** The parts of the page whose line changed since the open page model call read it. */
  private pagePartsEditedSinceTheCall(): string[] {
    if (this.pageTextAtCall === null) return [];
    const atCall = this.pageTextAtCall.split("\n");
    const now = this.pageText().split("\n");
    return Object.entries(PAGE_PART_LINES)
      .filter(([, index]) => atCall[index] !== now[index])
      .map(([part]) => part)
      .toSorted();
  }

  private specPersonCommentOf(comment: ReplayComment, author: TaskRow): SpecPersonComment {
    const host = this.host();
    const prompts = this.world.promptsQueuedFor(author.task_id);
    const lineIds = host.lineIds(this.requirePageId());
    return {
      commentThread: comment.commentThread,
      onTheBlock: comment.onTheBlock,
      mentions: comment.mentions,
      acknowledged: host.isAcknowledged(comment.hostId),
      gone: comment.lineId !== null && !lineIds.includes(comment.lineId),
      sent: prompts.some((prompt) => labeledPageCommentIds(prompt).includes(comment.hostId)),
      answered: host.events.some(
        (event) => event.kind === "reply" && event.commentId === comment.hostId,
      ),
    };
  }

  /** The comments code posted on the page for refiner runs, oldest first. */
  private reviewComments(runs: TaskRow[]): SpecReviewComment[] {
    if (this.revisions.kind !== "page") return [];
    const { pageId } = this.revisions;
    return this.host().postedComments.flatMap((posted): SpecReviewComment[] => {
      if (posted.pageId !== pageId) return [];
      const signed = /· task (\S+)\s*$/.exec(posted.text)?.[1];
      const run = runs.findIndex((candidate) => candidate.task_id === signed);
      if (run === -1) return [];
      if (posted.passage !== null) {
        const passage = QUOTED_PASSAGES[posted.passage];
        if (!passage) throw new Error(`a review quoted ${posted.passage}`);
        return [{ kind: "inline", run, passage }];
      }
      if (posted.text.startsWith("Review:")) {
        const findings = Object.entries(FINDING_MARKERS)
          .filter(([, marker]) => posted.text.includes(marker))
          .map(([passage]) => passage)
          .toSorted();
        const approves = posted.text.startsWith("Review: approved");
        return [{ kind: "outcome", run, findings, approves }];
      }
      return [{ kind: "rejection", run }];
    });
  }

  private async judgeTurnEnds(): Promise<void> {
    const run = this.world.refinerRunOf(this.author);
    if (!run) throw new Error("no refiner run is unfinished");
    const runId = this.runIdOf(run);
    const gatewayBefore = this.world.workflow.gatewayInstance;
    let answer: ((decisions: Decisions) => void) | null = null;
    const callOut = new Promise<"held">((callArrived) => {
      const holdRuling = new InterleavedDecisions(
        new FakeDecisions(rulingAnswers(0)),
        (questions) => {
          if (!("rejects" in questions.yesNo)) return null;
          callArrived("held");
          return new Promise<Decisions>((release) => {
            answer = release;
          });
        },
      );
      this.world.workflow.gatewayInstance = new FakeGateway({ decisions: holdRuling });
    });
    const turnEnd = this.world.apply(judgeClosesWithItsConclusion(run));
    const outcome = await Promise.race([callOut, turnEnd.then(() => "ended" as const)]);
    this.world.workflow.gatewayInstance = gatewayBefore;
    if (outcome === "held" && answer) this.held.set(runId, { answer, turnEnd });
  }

  private async answerRuling(action: RulingAction, step: TraceStep): Promise<void> {
    const { judgeRun } = step;
    const held = judgeRun === null ? undefined : this.held.get(judgeRun);
    if (judgeRun === null || !held) throw new Error(`no ruling call is out for ${judgeRun}`);
    this.held.delete(judgeRun);
    const post = action === "decisionsModelCannotRule" ? "HostTakes" : pickTag(step, "post");
    await this.whileRejectionPosts(post, () =>
      this.untilModelCall(async () => {
        held.answer(new FakeDecisions(rulingAnswers(RULING_PROBABILITIES[action])));
        await held.turnEnd;
      }),
    );
  }

  private judgeEntriesThatRejected(author: TaskRow, artifact: ArtifactRow): number[] {
    const notes = this.world.workflow.notes.map((note) => note.text);
    return this.world.workflow.stageForTask(author).reviewers.flatMap((entry, index) => {
      const rejection = `The ${entry.name} judge rejected ${artifact.external_url}.`;
      return notes.some((note) => note.includes(rejection)) ? [index] : [];
    });
  }

  private runsWhoseFindingsReachedTheAuthor(author: TaskRow, runs: TaskRow[]): number[] {
    const prompts = this.world.promptsQueuedFor(author.task_id);
    return runs.flatMap((run, runId) => {
      if (run.result?.kind !== "review" || !run.result.findings.length) return [];
      const reached = run.result.findings.every((finding) =>
        prompts.some((prompt) => prompt.includes(`- ${findingText(finding)}`)),
      );
      return reached ? [runId] : [];
    });
  }

  private runIdOf(run: TaskRow): number {
    return this.world.workflow.store
      .refinerRunsOf(run.job_id)
      .findIndex((candidate) => candidate.task_id === run.task_id);
  }
}

/**
 * What the agent read about page comments, as the spec names it: the text of a comment that was
 * held when the step began, that held comments stay held, and the mention that came in.
 */
function agentHeardOf(heard: string, said: Pick<HeardInStep, "heldTexts" | "mention">): string[] {
  const notes: string[] = [];
  if (said.heldTexts.some((heldText) => heard.includes(heldText))) notes.push("HeldCommentText");
  if (heard.includes("They stay held")) notes.push("HeldCommentsStayHeld");
  if (said.mention !== null && heard.includes(said.mention)) notes.push("MentionText");
  return notes;
}

function commentPlaceOf(picked: unknown): CommentPlace {
  const place = itfVariant(picked)!;
  switch (place.tag) {
    case "OnThePageAsAWhole":
      return { place: "page" };
    case "OnTheBlock":
      return { place: "block" };
    case "InTheCommentThreadOf":
      return { place: "comment_thread", of: itfInt(place.value) };
    case "UnderTheReviewComment":
      return { place: "review", of: itfInt(place.value) };
    default:
      throw new Error(`the trace has comment place ${place.tag}`);
  }
}

function pickOf(step: TraceStep, name: string): unknown {
  if (!(name in step.picks)) throw new Error(`${step.action} picked no ${name}`);
  return step.picks[name];
}

function pickTag(step: TraceStep, name: string): string {
  return itfVariant(pickOf(step, name))!.tag;
}

const WORLD_SETUP: Omit<WorldSetup, "refiners"> = {
  opening: "job",
  artifact: "pull",
  research: false,
  pageAuthor: "harness",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  origin: "chat",
  firstInput: "request",
  subject: "none",
  sandboxStart: "at_task_start",
};

/** The page a model-call author produces. Its lines line up with the parts the spec edits. */
const PRODUCED_PAGE_TEXT = [
  "# Login redirect",
  "",
  "Send the user back to the page they left.",
  "",
  "1. Keep one table",
  `2. ${PAGE_OPTION}`,
].join("\n");

/** A model-call author's turn the page model holds open, with the work that waits on it. */
type OpenModelTurn = { work: Promise<unknown> };

/**
 * Run `work` until it ends or the page model takes a call. The call keeps the model-call author's
 * turn open, so `work` comes back unfinished, for the step that answers the call to await.
 */
async function untilModelCall(
  pageModel: HeldPageModel,
  work: () => Promise<unknown>,
): Promise<OpenModelTurn | null> {
  const callOut = pageModel.nextCall();
  const running = work();
  const outcome = await Promise.race([callOut, running.then(() => "ended" as const)]);
  return outcome === "call_out" ? { work: running } : null;
}

function firstAuthorOf(world: WorkflowWorld): WorldAuthor {
  const author = world.authorAt(0);
  if (!author) throw new Error("the world opened without an author");
  return author;
}

function pageRevisionsOf(world: WorkflowWorld, author: WorldAuthor): ArtifactRevisions {
  const ref = world.artifactOf(author)?.ref;
  if (ref?.kind !== "page") throw new Error("the author opened no page");
  const revision = world.pageHost.pageRevision(ref.page_id);
  return { kind: "page", pageId: ref.page_id, revisionAtOpen: Number(revision) };
}

/** A gateway whose decisions model gives `decision` on the review again question alone. */
function reviewAgainGateway(decision: ReviewAgainDecision): FakeGateway {
  const failing = new FakeDecisions(REVIEW_AGAIN_ANSWERS.AgentRoutes);
  const answering = new FakeDecisions(REVIEW_AGAIN_ANSWERS[decision]);
  return new FakeGateway({
    decisions: new InterleavedDecisions(failing, (questions) =>
      "review_again" in questions.yesNo ? Promise.resolve(answering) : null,
    ),
  });
}

function rulingAnswers(rejects: number) {
  return { for_author: 0, beyond_author: 0, rejects };
}

function isRulingAction(action: string): action is RulingAction {
  return action in RULING_PROBABILITIES;
}

function isAuthorTurnEnd(action: string): boolean {
  return action === "authorTurnEndsOnANewRevision" || action === "authorTurnEndsOnTheSameRevision";
}

function judgeClosesWithItsConclusion(run: TaskRow): WorkflowAction {
  return {
    toString: () => `judge ${run.task_id} closes with its conclusion`,
    run: async (world) => {
      const bridge = await world.bridgeWithRunningTurn(run.task_id);
      if (!bridge) throw new Error(`judge ${run.task_id} has no running turn`);
      await bridge.say(JUDGE_CONCLUSION);
      await bridge.endTurn("end_turn");
      return { refinerTurnEnd: { task_id: run.task_id } };
    },
  };
}

function specRunOf(run: TaskRow, revisionCount: (revision: string | null) => number): SpecRun {
  return {
    refinerIndex: run.refiner_index ?? 0,
    status: SPEC_STATUSES[run.status],
    result: specResultOf(run.result, revisionCount),
    restarts: run.restarts,
  };
}

const SPEC_STATUSES: Record<TaskStatus, SpecRun["status"]> = {
  queued: "Unfinished",
  provisioning: "Unfinished",
  working: "Unfinished",
  in_review: "Unfinished",
  done: "Done",
  cancelled: "Cancelled",
  failed: "Failed",
};

function specResultOf(
  result: TaskRow["result"],
  revisionCount: (revision: string | null) => number,
): SpecRun["result"] {
  if (!result) return { filed: "nothing" };
  if (result.kind === "ruling") {
    return {
      filed: "ruling",
      ruling: result.ruling === "approved" ? "Approved" : "Rejected",
      revision: revisionCount(result.revision),
    };
  }
  return {
    filed: "review",
    revision: revisionCount(result.revision),
    findings: result.blocking || result.findings.length > 0,
  };
}
