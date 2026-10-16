import { setSystemTime } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import { FakeDecisions, type FakeAnswers } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { labeledPageCommentIds } from "../src/artifact/page-comment-label";
import { findingText } from "../src/artifact/review-text";
import { CLOSING_TEXT_MARKER, replyMarker } from "../src/prompts/model-author-prompt";
import type { ArtifactRow, TaskRow } from "../src/workflow/store/tasks";
import { taskAtWork } from "../src/workflow/task/at-work";
import { JUDGE_CONCLUSION, MODEL_AUTHOR_MODEL } from "./fake-runtime";
import { HeldPageModel } from "./held-page-model";
import { InterleavedDecisions } from "./interleaved-decisions";
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
export const TRACE_STEPS = 25;

const SPEC_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../../spec/review-loop");
const QUINT_CLI = createRequire(import.meta.url).resolve("@informalsystems/quint/dist/src/cli.js");
const STEP_MS = 10 * 60_000;
const REPLAY_START = Date.parse("2026-01-01T00:00:00.000Z");

/** One refiner run as the spec sees it. */
export type SpecRun = {
  refinerIndex: number;
  status: "Unfinished" | "Done" | "Cancelled" | "Failed";
  result:
    | { filed: "nothing" }
    | { filed: "review"; revision: number; findings: boolean }
    | { filed: "ruling"; ruling: "Approved" | "Rejected"; revision: number };
  restarts: number;
};

/** The review of one artifact as the spec sees it. */
export type SpecReview = {
  author: {
    atWork: boolean;
    queuedPrompts: number;
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
};

/** One state of a trace: the action that led to it, the judge run it picked, and the review. */
export type TraceStep = {
  action: string;
  judgeRun: number | null;
  decision: ReviewAgainDecision | null;
  review: SpecReview;
};

const REVIEW_AGAIN_DECISIONS = ["ReviewAgain", "NoReviewAgain", "AgentRoutes"] as const;

/** What the review again decision says when a model-call author's turn ends. */
type ReviewAgainDecision = (typeof REVIEW_AGAIN_DECISIONS)[number];

/** Run the spec of one setup for `count` traces from `seed`, each checked against its invariants. */
export function generateTraces(setup: SpecSetup, count: number, seed: number): TraceStep[][] {
  const directory = mkdtempSync(join(tmpdir(), "review-loop-"));
  try {
    const quint = spawnSync(
      process.execPath,
      [
        QUINT_CLI,
        "run",
        join(SPEC_DIRECTORY, `${setup}.qnt`),
        `--main=${setup}`,
        "--backend=typescript",
        "--mbt",
        `--max-steps=${TRACE_STEPS}`,
        `--max-samples=${count}`,
        `--n-traces=${count}`,
        `--seed=${seed}`,
        `--out-itf=${join(directory, "trace_{seq}.itf.json")}`,
      ],
      { encoding: "utf8" },
    );
    if (quint.status !== 0) {
      throw new Error(`quint run failed for ${setup}:\n${quint.stdout}\n${quint.stderr}`);
    }
    return readdirSync(directory)
      .toSorted((left, right) => traceNumber(left) - traceNumber(right))
      .map((file) => traceSteps(setup, JSON.parse(readFileSync(join(directory, file), "utf8"))));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function traceNumber(file: string): number {
  return Number(file.replace(/\D/g, ""));
}

function traceSteps(setup: SpecSetup, trace: unknown): TraceStep[] {
  return list(field(trace, "states")).map((state) => {
    const picks = field(state, "mbt::nondetPicks");
    const picked = variant(field(picks, "judgeRun", true));
    const decision = variant(field(picks, "decision", true));
    return {
      action: text(field(state, "mbt::actionTaken")),
      judgeRun: picked?.tag === "Some" ? int(picked.value) : null,
      decision:
        decision?.tag === "Some"
          ? oneOf(text(field(decision.value, "tag")), REVIEW_AGAIN_DECISIONS)
          : null,
      review: specReview(field(state, `${setup}::reviewLoop::review`)),
    };
  });
}

function specReview(value: unknown): SpecReview {
  const author = field(value, "author");
  const artifact = field(value, "artifact");
  const status = variant(field(artifact, "status"))!;
  const refinerRun = variant(field(artifact, "refinerRun"))!;
  return {
    author: {
      atWork: bool(field(author, "atWork")),
      queuedPrompts: int(field(author, "queuedPrompts")),
      rejectedBy: sortedInts(field(author, "rejectedBy")),
      findingsFrom: sortedInts(field(author, "findingsFrom")),
    },
    artifact: {
      status:
        status.tag === "Ready"
          ? { status: "Ready", deliveredRevision: int(field(status.value, "deliveredRevision")) }
          : { status: "Drafted" },
      revision: int(field(artifact, "revision")),
      refinerRun: refinerRun.tag === "OnRefinerRun" ? int(refinerRun.value) : null,
    },
    refinerRuns: list(field(value, "refinerRuns")).map(specRun),
    judgeRunsCodeRulesOn: sortedInts(field(value, "judgeRunsCodeRulesOn")),
  };
}

function sortedInts(set: unknown): number[] {
  return list(field(set, "#set"))
    .map(int)
    .toSorted((left, right) => left - right);
}

function specRun(value: unknown): SpecRun {
  const result = variant(field(value, "result"))!;
  return {
    refinerIndex: int(field(value, "refinerIndex")),
    status: oneOf(variant(field(value, "status"))!.tag, RUN_STATUSES),
    result: specResult(result),
    restarts: int(field(value, "restarts")),
  };
}

const RUN_STATUSES = ["Unfinished", "Done", "Cancelled", "Failed"] as const;
const RULINGS = ["Approved", "Rejected"] as const;

function specResult(result: { tag: string; value: unknown }): SpecRun["result"] {
  switch (result.tag) {
    case "FiledReview":
      return {
        filed: "review",
        revision: int(field(result.value, "revision")),
        findings: bool(field(result.value, "findings")),
      };
    case "FiledRuling":
      return {
        filed: "ruling",
        ruling: oneOf(variant(field(result.value, "ruling"))!.tag, RULINGS),
        revision: int(field(result.value, "revision")),
      };
    default:
      return { filed: "nothing" };
  }
}

function field(value: unknown, name: string, optional = false): unknown {
  if (typeof value === "object" && value !== null && name in value) {
    return Object.getOwnPropertyDescriptor(value, name)?.value;
  }
  if (optional) return null;
  throw new Error(`the trace has no ${name} in ${JSON.stringify(value)}`);
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`the trace has ${JSON.stringify(value)}, not a list`);
  return value;
}

function int(value: unknown): number {
  return Number(text(field(value, "#bigint")));
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error(`the trace has ${JSON.stringify(value)}, not a bool`);
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error(`the trace has ${JSON.stringify(value)}, not text`);
  return value;
}

function variant(value: unknown): { tag: string; value: unknown } | null {
  if (value === null) return null;
  return { tag: text(field(value, "tag")), value: field(value, "value") };
}

function oneOf<Name extends string>(name: string, names: readonly Name[]): Name {
  const known = names.find((candidate) => candidate === name);
  if (!known) throw new Error(`the trace has ${name}, not one of ${names.join(", ")}`);
  return known;
}

/** The ruling answers the decisions model gives a held conclusion. */
const RULING_PROBABILITIES = {
  decisionsModelApproves: 0.1,
  decisionsModelRejects: 0.9,
  decisionsModelCannotRule: 0.5,
} as const;

type RulingAction = keyof typeof RULING_PROBABILITIES;

const TURN_END: Omit<RefinerRunEnd, "reviewer" | "polisher" | "closing"> = {
  pageCommenting: "takes",
  judge: "approves",
  whileRuled: "nothing",
  stopReason: "end_turn",
};

const WORLD_ACTIONS: Record<string, WorkflowAction> = {
  agentPromptsAuthor: agentPromptsAuthor(0),
  authorTurnEndsOnANewRevision: authorTurnEnds(0, "changed", "finished"),
  authorTurnEndsOnTheSameRevision: authorTurnEnds(0, "same", "finished"),
  findingsReviewerLeavesFindings: refinerRunEnds(0, {
    ...TURN_END,
    reviewer: "findings",
    polisher: "nothing_pushed",
    closing: "reports_work",
  }),
  findingsReviewerApproves: refinerRunEnds(0, {
    ...TURN_END,
    reviewer: "approved",
    polisher: "nothing_pushed",
    closing: "reports_work",
  }),
  polisherPushes: refinerRunEnds(0, {
    ...TURN_END,
    reviewer: "no_review",
    polisher: "pushed",
    closing: "reports_work",
  }),
  polisherPushesNothing: refinerRunEnds(0, {
    ...TURN_END,
    reviewer: "no_review",
    polisher: "nothing_pushed",
    closing: "reports_work",
  }),
  refinerRunGivesUp: refinerRunEnds(0, {
    ...TURN_END,
    reviewer: "no_review",
    polisher: "nothing_pushed",
    closing: "gives_up",
  }),
  personApproves: personRules(0, "approve"),
  personRejects: personRules(0, "reject"),
  agentRequestsReview: agentRoutes(0, "request_review"),
  agentFinishesReview: agentRoutes(0, "finish_review"),
  agentCancelsRefinerRun: agentCancels(0, "refiner_run"),
  refinerRunFails: refinerRunFails(0),
};

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

/**
 * Replays spec traces through a workflow world with one author. Each spec action maps to one
 * world action. A judge turn end stays open while the decisions model holds its ruling call,
 * until a later spec step answers it. A model-call author's turn stays open while the page model
 * holds its call, until a later spec step ends the turn.
 */
export class ReviewLoopReplay {
  readonly world: WorkflowWorld;
  private readonly author: WorldAuthor;
  private readonly revisions: ArtifactRevisions;
  private readonly pageModel: HeldPageModel | null;
  private readonly held = new Map<number, HeldRuling>();
  private step = 0;
  private modelTurn: OpenModelTurn | null;

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
    if (step.action === "judgeTurnEnds") await this.judgeTurnEnds();
    else if (isRulingAction(step.action)) await this.answerRuling(step.action, step.judgeRun);
    else if (this.pageModel && isAuthorTurnEnd(step.action)) {
      await this.modelTurnEnds(step.action === "authorTurnEndsOnANewRevision", step.decision);
    } else {
      const action = this.worldActionFor(step.action);
      await this.untilModelCall(() => this.world.apply(action));
    }
    for (const task of this.world.tasksAwaitingSandbox()) {
      await this.world.startSandboxOf(task.task_id);
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

  /** The store as the spec sees it. */
  project(): SpecReview {
    const { store } = this.world.workflow;
    const author = this.world.taskOf(this.author);
    const artifact = this.world.artifactOf(this.author);
    if (!artifact) throw new Error("the author has no artifact");
    const runs = store.refinerRunsOf(author.job_id);
    const pointer = runs.findIndex((run) => run.task_id === artifact.refiner_task_id);
    const delivered = artifact.delivered_revision;
    const atWork = taskAtWork(this.world.workflow, author);
    const queued = store.queue().filter((row) => row.task_id === author.task_id).length;
    const revisionCount = (revision: string | null) => this.revisionCount(revision);
    return {
      author: {
        atWork,
        queuedPrompts: this.pageModel && atWork ? queued - 1 : queued,
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
    };
  }

  private worldActionFor(action: string): WorkflowAction {
    if (this.revisions.kind === "page" && action === "authorTurnEndsOnANewRevision") {
      return this.afterPageEdit(WORLD_ACTIONS.authorTurnEndsOnTheSameRevision!);
    }
    if (this.revisions.kind === "page" && action === "polisherPushes") {
      return this.afterPageEdit(WORLD_ACTIONS.polisherPushesNothing!);
    }
    const mapped = WORLD_ACTIONS[action];
    if (!mapped) throw new Error(`no world action for spec action ${action}`);
    return mapped;
  }

  /** The author or a polisher edits the page on the host, then `action` runs. */
  private afterPageEdit(action: WorkflowAction): WorkflowAction {
    return {
      toString: () => `the page changes, then ${String(action)}`,
      run: async (world) => {
        const pageId = this.requirePageId();
        world.pageHost.seedPage(pageId, `${world.pageHost.pageText(pageId)}\nEdit ${this.step}.`);
        return action.run(world);
      },
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

  /** The model-call author's revise call answers, on a changed page or on the same one. */
  private async modelTurnEnds(
    changed: boolean,
    decision: ReviewAgainDecision | null,
  ): Promise<void> {
    const pageModel = this.pageModel;
    const asked = pageModel?.heldUserText ?? null;
    if (asked === null) throw new Error("the model-call author has no turn in flight");
    if (!decision) throw new Error("the spec ended a model-call author's turn without a decision");
    const pageText = await this.world.pageHost.readPageContent(this.requirePageId());
    const revised = changed ? `${pageText}\nEdit ${this.step}.` : pageText;
    const replies = labeledPageCommentIds(asked).flatMap((commentId) => [
      replyMarker(commentId),
      "Answered on the page.",
    ]);
    const gatewayBefore = this.world.workflow.gatewayInstance;
    this.world.workflow.gatewayInstance = reviewAgainGateway(decision);
    await this.answerModelCall(
      [revised, "", CLOSING_TEXT_MARKER, "Revised the page.", ...replies].join("\n"),
    );
    this.world.workflow.gatewayInstance = gatewayBefore;
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

  private async answerRuling(action: RulingAction, judgeRun: number | null): Promise<void> {
    const held = judgeRun === null ? undefined : this.held.get(judgeRun);
    if (judgeRun === null || !held) throw new Error(`no ruling call is out for ${judgeRun}`);
    this.held.delete(judgeRun);
    await this.untilModelCall(async () => {
      held.answer(new FakeDecisions(rulingAnswers(RULING_PROBABILITIES[action])));
      await held.turnEnd;
    });
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

const PRODUCED_PAGE_TEXT = [
  "# Login redirect",
  "",
  "Send the user back to the page they left.",
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
