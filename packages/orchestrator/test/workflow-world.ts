import { gt, max, sql } from "drizzle-orm";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type {
  CheckFailure,
  CommitChecks,
  PullRequestReview,
  PullRequestReviewComment,
} from "@artfct-ai/adapters/code/types";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import type { Choice, Decisions } from "@artfct-ai/adapters/gateway/types";
import type { HeldComment } from "@artfct-ai/adapters/documents/types";
import type { AgentActivityContent } from "@artfct-ai/adapters/tracker/types";
import { FakeDecisions, HangingDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import { OPTIONS_HEADING } from "../src/artifact/options";
import { labeledPageCommentIds } from "../src/artifact/page-comment-label";
import type { RefinerEntry, ReviewerEntry } from "../src/config/refiner";
import { Notifier } from "../src/notify/notifier";
import { startJob, type JobIssue } from "../src/workflow/lifecycle";
import { createWorkflow, handleEvent } from "../src/workflow/inbound/events";
import { parseVerbalCommand } from "../src/workflow/inbound/verbal-command";
import { plainText } from "../src/notify/messages";
import { outbox } from "../src/workflow/store/schema";
import { isTaskFinished, type Subject } from "../src/workflow/store/state";
import { originSubject, setWorkflowSubject } from "../src/workflow/subject";
import type { ArtifactRow, JobRow, RulingState, TaskRow } from "../src/workflow/store/tasks";
import { judgeRuled } from "../src/workflow/refiner/stage-refiner";
import { onBridgeClosed, type ConnectionState } from "../src/workflow/task/harness/bridge";
import { provision } from "../src/workflow/task/sandbox/sandbox";
import { taskAtWork } from "../src/workflow/task/at-work";
import { onModelTurnDeadline, type ModelTurnAlarm } from "../src/workflow/task/model-turn";
import { runStartStep } from "./restart";
import { sqliteD1 } from "./sqlite-d1";
import { FakeBridge } from "./fake-bridge";
import { InterleavedDecisions, onFirstCall, onFirstCallAsking } from "./interleaved-decisions";
import { CLOSING_TEXT_MARKER, replyMarker } from "../src/prompts/model-author-prompt";
import { EchoModel, ScriptedFailure } from "./fake-model";
import {
  fakeDocumentsOf,
  FakeRuntime,
  JUDGE_ENTRY,
  MODEL_AUTHOR_MODEL,
  PAGE_PARENT,
  patchStagePolishers,
  patchStageResearch,
  patchStageReviewers,
} from "./fake-runtime";
import type { Observation, Step } from "./invariants";
import { openMemoryDb, type MemoryDb } from "./memory-db";
import { WorkBudget } from "./work-budget";
import { activityText, SessionTracker, type TrackerHealth } from "./session-tracker";
import { testEnv } from "./test-env";
import {
  strayIssueKey,
  SUBJECT_ISSUE_KEY,
  WORLD_ISSUES,
  WORLD_PROJECT,
  WORLD_PROJECTS,
  worldIssueUrl,
} from "./world-tracker";

/** The refiner lists a world can declare on its stages. */
export const REFINER_SETUPS = [
  "none",
  "reviewer",
  "judge",
  "judge_between_reviewers",
  "two_reviewers",
  "reviewer_then_polisher",
  "polisher",
  "judge_then_polisher",
  "two_reviewers_then_polisher",
] as const;

export type RefinerSetup = (typeof REFINER_SETUPS)[number];

/**
 * What one generated world is made of: the artifact kind of its first task, its refiner lists,
 * whether its stages run a researcher before the author, how the page author runs, what the
 * checks say on a new push, and how the page stage ends.
 */
export type WorldSetup = {
  opening: WorldOpening;
  artifact: ArtifactKind;
  refiners: RefinerSetup;
  research: boolean;
  pageAuthor: PageAuthor;
  checksOnPush: ChecksOnPush;
  pageEnding: PageEnding;
  origin: OriginSurface;
  firstInput: FirstInput;
  subject: PlannedSubject;
  sandboxStart: SandboxStart;
};

/**
 * When the sandbox of a new task comes up: right after the action that started the task, or
 * when an action brings it up.
 */
type SandboxStart = "at_task_start" | "on_an_action";

/**
 * What the plan of a world that opens on its first job named as the subject, when the origin
 * does not set one. A first job on the origin issue needs that issue as the subject.
 */
type PlannedSubject = "none" | "project";

/**
 * What a tracker link a breakdown author ends its turn with, or a plan names, points at: the
 * subject issue, the world's project, or an issue outside both.
 */
export type TrackerLink = "the_subject_issue" | "a_project" | "a_stray_issue";

type FirstInput = "request" | "origin_issue";

/** How the author of the page stage runs: in a harness session, or as model calls. */
type PageAuthor = "harness" | "model";

/**
 * What the model of a model-call page author does on each call until an action changes it. A
 * `page` answer replies to each page comment the prompt labels, and `skips_replies` replies to
 * none.
 */
export type PageModelAnswer = "page" | "skips_replies" | "blank" | "throws";

const ORIGIN_ISSUE: JobIssue = {
  id: SUBJECT_ISSUE_KEY,
  key: SUBJECT_ISSUE_KEY,
  title: "Fix login",
  team_id: null,
  started: false,
};

/**
 * How a world opens: on its first job, on its first job before its author started, or on a
 * request the agent has not planned.
 */
type WorldOpening = "job" | "job_unstarted" | "request";

/** Where the request that started the workflow came from: a chat thread or a tracker session. */
type OriginSurface = "chat" | "tracker";

const ORIGINS: Record<OriginSurface, ReplyTarget> = {
  chat: { source: "chat", channel: "C1", thread: "1.0" },
  tracker: { source: "tracker", session_id: "session-origin", issue_id: SUBJECT_ISSUE_KEY },
};

/** How a job on the page stage ends: a person accepts the page, or selects one of its options. */
type PageEnding = "acceptance" | "choice";

/**
 * What the checks say about a revision the moment it is pushed: they already passed, or nothing
 * has reported yet and a later report says how they went.
 */
export type ChecksOnPush = "passed" | "reported_later";

/** What the host's checks say about the head revision of a pull request. */
export type ChecksReport =
  | "unreported"
  | "running"
  | "failed"
  | "stopped"
  | "passed_just_now"
  | "passed_long_ago";

/** Whether the host can merge a pull request into its base, or has not worked it out yet. */
export type Mergeability = "clean" | "conflicted" | "unknown";

/** Where a pull request stands on the host. An unopened one is not there yet. */
type PullState = "unopened" | "open" | "closed" | "merged";

/** A pull request on the host. Two authors share one when a later job continues it. */
type WorldPull = {
  number: number;
  state: PullState;
  branch: string;
  revisionNumber: number;
  reviews: PullRequestReview[];
  headChecks: CommitChecks;
  mergeability: Mergeability;
};

/** The artifact kinds a world runs tasks for. */
export type ArtifactKind = "pull" | "issues" | "page";

/** The stage whose tasks produce each artifact kind. */
export const STAGE_OF: Record<ArtifactKind, string> = {
  pull: "implement",
  issues: "breakdown",
  page: "design",
};

/** An option every page of a world lists under its options heading. */
export const PAGE_OPTION = "Split the table";

/** The comment held on every page of a world until it is sent. */
export const HELD_COMMENT: HeldComment = {
  id: "held-1",
  author_name: "Ann",
  text: "Name the owner of the table.",
};

const PAGE_TEXT = [
  "# Sessions",
  "",
  `## ${OPTIONS_HEADING}`,
  "",
  "1. Keep one table",
  `2. ${PAGE_OPTION}`,
].join("\n");

/** The most author tasks the agent tries to hold in one world. It is more than the slots. */
export const MAX_AUTHORS = 4;

/** The most pages a world's authors can number. Each author numbers its artifact by its place. */
const MAX_PAGES = 20;

/** The job slots of the workflow of a world. */
const SLOTS = 2;

/** The texts a person asks for ad hoc work with. The first one started the world's first job. */
export const REQUEST_TEXTS = ["Fix the login redirect.", "Add a logout link."] as const;

/** The workflow definition the deployment of a world holds besides the test one. */
export const SECOND_DEFINITION = "incident";

/** The repository of the workflow of a world. */
export const REPO = "acme/app";

/** What an action tells the world about itself, for the step record. */
export type StepFacts = Partial<
  Pick<
    Step,
    | "authorTurnEnd"
    | "staleAlarm"
    | "completion"
    | "modelCallStopped"
    | "plan"
    | "start"
    | "finishedByAgent"
    | "modelTurnCut"
    | "pageCommentsRefused"
  >
>;

const PAGE_WRITES: readonly string[] = ["createPage", "updatePageContent", "renamePage"];

/** One thing that happens to a workflow. It picks its target from the world and may do nothing. */
export type WorkflowAction = {
  run(world: WorkflowWorld): Promise<StepFacts | void>;
  toString(): string;
};

/**
 * The probabilities a decisions model answers with, a model whose every call fails, or one that
 * never answers before its caller's signal aborts.
 */
export type DecisionAnswers =
  | {
      for_author: number;
      beyond_author: number;
      rejects: number;
      gave_up?: number;
      accepts?: number;
      selected?: Choice;
      outcome?: Choice;
    }
  | "fails"
  | "hangs";

/**
 * One author task and the number of its artifact on the host. An author that continues an open
 * pull request shares its number with the author that opened it. Every other author has its own.
 */
export type WorldAuthor = { taskId: string; kind: ArtifactKind; pullNumber: number };

/** A pull request in the workflow's repository that no task of the workflow opened. */
export const UNOWNED_PULL = { repo: REPO, number: 99, branch: "someone/else" };

const PERSON = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

function requestEvent(origin: ReplyTarget): InboundEvent {
  return {
    id: "evt-request",
    kind: "start",
    actor: PERSON,
    bindings: [],
    links: [],
    text: REQUEST_TEXTS[0],
    reply_to: origin,
  };
}

const BASE_BRANCH = "main";

const FAILED_CHECK: CheckFailure = {
  name: "test",
  conclusion: "failure",
  detail: "2 tests failed",
  url: null,
};
const STOPPED_CHECK: CheckFailure = {
  name: "deploy",
  conclusion: "cancelled",
  detail: "",
  url: null,
};

const FINDINGS_REVIEWER: ReviewerEntry = {
  name: "Code review",
  mode: "findings",
  skill: "implement-review",
};
const SECOND_REVIEWER: ReviewerEntry = { ...FINDINGS_REVIEWER, name: "Second read" };
const POLISHER: RefinerEntry = { name: "Comments", skill: "technical-writer" };

const REFINER_LISTS: Record<
  RefinerSetup,
  { reviewers: ReviewerEntry[]; polishers: RefinerEntry[] }
> = {
  none: { reviewers: [], polishers: [] },
  reviewer: { reviewers: [FINDINGS_REVIEWER], polishers: [] },
  judge: { reviewers: [JUDGE_ENTRY], polishers: [] },
  judge_between_reviewers: {
    reviewers: [FINDINGS_REVIEWER, JUDGE_ENTRY, SECOND_REVIEWER],
    polishers: [],
  },
  two_reviewers: { reviewers: [FINDINGS_REVIEWER, SECOND_REVIEWER], polishers: [] },
  reviewer_then_polisher: { reviewers: [FINDINGS_REVIEWER], polishers: [POLISHER] },
  polisher: { reviewers: [], polishers: [POLISHER] },
  judge_then_polisher: { reviewers: [JUDGE_ENTRY], polishers: [POLISHER] },
  two_reviewers_then_polisher: {
    reviewers: [FINDINGS_REVIEWER, SECOND_REVIEWER],
    polishers: [POLISHER],
  },
};

function decidedRulingOf(ruling: RulingState | null): string | null {
  return judgeRuled(ruling) ? JSON.stringify(ruling) : null;
}

/**
 * One workflow with its author tasks, a code host, and the sandboxes of its tasks. Actions change
 * it through the entry points production uses, and every step is recorded for the invariants.
 */
export class WorkflowWorld {
  workflow: FakeRuntime;
  readonly steps: Step[] = [];
  readonly authors: WorldAuthor[] = [];
  private readonly pulls = new Map<number, WorldPull>();
  private readonly bridges: FakeBridge[] = [];
  private hostReadable = true;
  private pullsReadable = true;
  private hostReviewComments: Record<number, PullRequestReviewComment[]> = {};
  private reviewNumber = 0;
  private eventNumber = 0;
  private delivered: Step["event"] = null;
  private landed: Observation[] = [];
  private chatThreadsJoined = 0;
  private readonly checksOnPush: ChecksOnPush;
  readonly tracker: SessionTracker;
  private streamedTextCount = 0;
  private readonly modelTurnEnds: string[] = [];
  private readonly modelPromptTexts = new Map<string, string[]>();
  private readonly queuedPromptTexts = new Map<string, string[]>();
  private whilePageModelAnswers: ((taskId: string) => Promise<void>) | null = null;
  private readonly hungModelTurns = new Map<string, string | null>();

  /** The document host every page of the world lives on. */
  readonly pageHost: FakeDocuments;
  private readonly lastOutboxRow;
  private readonly outboxRowsAfterId;
  /** Counts the store statements of each step, and stops a step past its budget. */
  readonly workBudget: WorkBudget;

  private constructor(options: {
    workflow: FakeRuntime;
    db: MemoryDb;
    workBudget: WorkBudget;
    setup: WorldSetup;
    tracker: SessionTracker;
    pageHost: FakeDocuments;
  }) {
    this.workflow = options.workflow;
    this.lastOutboxRow = options.db
      .select({ id: max(outbox.id) })
      .from(outbox)
      .prepare();
    this.outboxRowsAfterId = options.db
      .select()
      .from(outbox)
      .where(gt(outbox.id, sql.placeholder("id")))
      .orderBy(outbox.id)
      .prepare();
    this.checksOnPush = options.setup.checksOnPush;
    this.tracker = options.tracker;
    this.pageHost = options.pageHost;
    this.workBudget = options.workBudget;
    this.recordQueuedPrompts();
    if (options.setup.pageAuthor === "model") {
      this.answerPageModelWith("page");
      this.recordPromptsModelTurnsTake();
    }
  }

  /** Keep the text of every prompt queued for a task, also one a stop or a cancel clears later. */
  private recordQueuedPrompts(): void {
    const { store } = this.workflow;
    const enqueuePrompt = store.enqueuePrompt.bind(store);
    store.enqueuePrompt = (taskId, text) => {
      const texts = this.queuedPromptTexts.get(taskId) ?? [];
      this.queuedPromptTexts.set(taskId, [...texts, text]);
      enqueuePrompt(taskId, text);
    };
  }

  /** The text of every prompt ever queued for the task, also one a stop or a cancel cleared. */
  promptsQueuedFor(taskId: string): string[] {
    return this.queuedPromptTexts.get(taskId) ?? [];
  }

  /** Keep the text of every prompt a model-call task takes off its queue, as a bridge keeps those it sends. */
  private recordPromptsModelTurnsTake(): void {
    const { store } = this.workflow;
    const dequeuePrompt = store.dequeuePrompt.bind(store);
    store.dequeuePrompt = (id) => {
      const taken = store.queue().find((row) => row.id === id);
      if (taken && !store.sandbox(taken.task_id)) {
        const texts = this.modelPromptTexts.get(taken.task_id) ?? [];
        this.modelPromptTexts.set(taken.task_id, [...texts, taken.text]);
      }
      dequeuePrompt(id);
    };
  }

  /**
   * Open a world on its first job, or on a person's request before the plan that starts the
   * workflow. The deployment holds a second workflow definition a plan may name.
   */
  static async open(setup: WorldSetup): Promise<WorkflowWorld> {
    const workBudget = new WorkBudget();
    const db = openMemoryDb(workBudget);
    const workflow = new FakeRuntime(db, { ...testEnv(), DB: sqliteD1() });
    const lists = REFINER_LISTS[setup.refiners];
    patchStageReviewers(workflow, lists.reviewers);
    patchStagePolishers(workflow, lists.polishers);
    if (setup.research) patchStageResearch(workflow);
    if (setup.pageEnding === "choice") patchPageEnding(workflow, "choice");
    if (setup.pageAuthor === "model") patchModelPageAuthor(workflow);
    workflow.addWorkflowDefinition({ ...workflow.workflowDefinition(), name: SECOND_DEFINITION });
    const documents = pageHost();
    workflow.documentsInstance = documents;
    workflow.gatewayInstance = new FakeGateway();
    const tracker = new SessionTracker({ issues: WORLD_ISSUES, projects: WORLD_PROJECTS });
    workflow.trackerInstance = tracker;
    workflow.notifier = new Notifier(
      { tracker: async () => tracker, chat: null, documents: async () => null },
      (entry) => workflow.store.writeOutbox(entry),
    );
    if (setup.opening === "request") {
      workflow.patchState({
        status: "new",
        definition: null,
        repo: { full: REPO },
        concurrency: SLOTS,
      });
      await createWorkflow(workflow, {
        workflowId: workflow.state.workflow_id,
        event: requestEvent(ORIGINS[setup.origin]),
        endedWorkflowId: null,
      });
      return new WorkflowWorld({
        workflow,
        db,
        workBudget,
        setup,
        tracker,
        pageHost: documents,
      });
    }
    const stage = STAGE_OF[setup.artifact];
    workflow.patchState({
      stages: [stage],
      repo: { full: REPO },
      request: { title: "Fix login", text: "Fix the login redirect.", links: [] },
      origin: ORIGINS[setup.origin],
      reply_targets: [ORIGINS[setup.origin]],
      concurrency: SLOTS,
    });
    const subject = openingSubject(setup);
    if (subject) await setWorkflowSubject(workflow, subject);
    const first = await startJob(workflow, {
      stage,
      brief: "Fix the login redirect.",
      input:
        setup.firstInput === "origin_issue"
          ? { kind: "issue", issue: ORIGIN_ISSUE }
          : { kind: "request", text: REQUEST_TEXTS[0] },
    });
    if (!first) throw new Error(`the test config declares no stage ${stage}`);
    const world = new WorkflowWorld({
      workflow,
      db,
      workBudget,
      setup,
      tracker,
      pageHost: documents,
    });
    world.adoptNewAuthors();
    if (setup.opening === "job_unstarted") return world;
    await world.startSandboxOf(workflow.store.authorOrResearcherTaskOf(first.job_id).task_id);
    return world;
  }

  /** Run one action and record what an observer saw around it. */
  async apply(action: WorkflowAction): Promise<Step> {
    const before = this.steps.at(-1)?.after ?? this.observe();
    const notesBefore = this.workflow.notes.length;
    const modelTurnEndsBefore = this.modelTurnEnds.length;
    const outboxBefore = this.lastOutboxId();
    const postedBefore = this.workflow.posted.length;
    const pageCommentsBefore = this.pageHost.postedComments.length;
    this.delivered = null;
    this.landed = [];
    const facts = await this.workBudget.within(String(action), async () => {
      const ran = (await action.run(this)) ?? {};
      this.adoptNewAuthors();
      await this.dropClosedSockets();
      return ran;
    });
    const rows = this.outboxRowsAfter(outboxBefore);
    const step: Step = {
      action: String(action),
      before,
      landed: this.landed,
      after: this.observe(),
      notes: this.workflow.notes.slice(notesBefore),
      authorTurnEnd: facts.authorTurnEnd ?? this.modelTurnEndSince(modelTurnEndsBefore),
      staleAlarm: facts.staleAlarm ?? null,
      completion: facts.completion ?? null,
      modelCallStopped: facts.modelCallStopped ?? null,
      modelTurnCut: facts.modelTurnCut ?? null,
      plan: facts.plan ?? null,
      issueUpdates: rows.filter((row) => row.kind === "issue_update").length,
      start: facts.start ?? null,
      finishedByAgent: facts.finishedByAgent ?? false,
      event: this.delivered,
      sessionPosts: sessionPostsOf(rows),
      postedTypes: this.workflow.posted.slice(postedBefore).map((event) => event.type),
      feedPosts: feedPostsOf(rows),
      postedTexts: this.workflow.posted.slice(postedBefore).map(plainText),
      pageCommentsPosted: this.pageHost.postedComments.slice(pageCommentsBefore),
      pageCommentsRefused: facts.pageCommentsRefused ?? false,
    };
    this.steps.push(step);
    return step;
  }

  /**
   * The author an action is about, or null before any author exists. `index` counts round the
   * unfinished authors. The last index, and every index once all authors finished, counts round
   * all of them.
   */
  authorAt(index: number): WorldAuthor | null {
    const unfinished = this.authors.filter((author) => !isTaskFinished(this.taskOf(author).status));
    const pool = index === MAX_AUTHORS - 1 || !unfinished.length ? this.authors : unfinished;
    return pool[index % pool.length] ?? null;
  }

  /** An author whose task finished, or null when none has. `index` counts round them. */
  finishedAuthorAt(index: number): WorldAuthor | null {
    const finished = this.authors.filter((author) => isTaskFinished(this.taskOf(author).status));
    return finished[index % finished.length] ?? null;
  }

  /** The unfinished researcher task an action is about, or null. `index` counts round them. */
  researcherAt(index: number): TaskRow | null {
    const researchers = this.workflow.store
      .tasks()
      .filter((task) => task.role === "researcher" && !isTaskFinished(task.status));
    return researchers[index % researchers.length] ?? null;
  }

  taskOf(author: WorldAuthor): TaskRow {
    return this.workflow.store.requireTask(author.taskId);
  }

  jobOf(author: WorldAuthor): JobRow {
    return this.workflow.store.requireJob(this.taskOf(author).job_id);
  }

  artifactOf(author: WorldAuthor): ArtifactRow | null {
    return this.workflow.store.artifact(this.taskOf(author).job_id);
  }

  /** The unfinished refiner run of the author's artifact, or null. */
  refinerRunOf(author: WorldAuthor): TaskRow | null {
    return (
      this.workflow.store
        .refinerRunsOf(this.taskOf(author).job_id)
        .findLast((run) => !isTaskFinished(run.status)) ?? null
    );
  }

  /** The reviewer entry a run was started for, or null for a polisher run. */
  reviewerEntryOf(run: TaskRow): ReviewerEntry | null {
    if (run.role !== "reviewer" || run.refiner_index === null) return null;
    return this.workflow.stageForTask(run).reviewers[run.refiner_index] ?? null;
  }

  /** The newest open bridge of a task whose turn runs, or null. */
  runningBridgeOf(taskId: string): FakeBridge | null {
    return (
      this.bridges.findLast(
        (bridge) => bridge.taskId === taskId && bridge.open && bridge.turnRunning,
      ) ?? null
    );
  }

  /** The newest open bridge of a task, or null. */
  openBridgeOf(taskId: string): FakeBridge | null {
    return this.bridges.findLast((bridge) => bridge.taskId === taskId && bridge.open) ?? null;
  }

  /** The bridge of a refiner run whose turn runs. A run whose sandbox has not come up gets it first. */
  async bridgeWithRunningTurn(taskId: string): Promise<FakeBridge | null> {
    await this.startSandboxOf(taskId);
    return this.runningBridgeOf(taskId);
  }

  /** What the host says the author's artifact is now. Null when it cannot say. */
  hostRevisionOf(author: WorldAuthor): string | null {
    const pull = this.pullOf(author);
    if (author.kind !== "pull" || pull.state === "unopened") return null;
    if (!this.hostReadable || !this.pullsReadable) return null;
    return revisionOf(pull);
  }

  /** True when an earlier author opened the pull request this author works on. */
  continuesPull(author: WorldAuthor): boolean {
    return this.authors.find((other) => other.pullNumber === author.pullNumber) !== author;
  }

  /** The link an author prints when it opens its artifact. */
  artifactUrlOf(author: WorldAuthor): string {
    switch (author.kind) {
      case "pull":
        return pullUrl(author.pullNumber);
      case "issues":
        return this.artifactOf(author)?.external_url ?? worldIssueUrl(SUBJECT_ISSUE_KEY);
      case "page":
        return pageUrl(author.pullNumber);
      default: {
        const unreachable: never = author.kind;
        throw new Error(`unhandled artifact kind ${String(unreachable)}`);
      }
    }
  }

  /** The URL of a tracker link. `index` numbers the stray issue it names. */
  trackerLinkUrl(link: TrackerLink, index: number): string {
    switch (link) {
      case "the_subject_issue":
        return worldIssueUrl(SUBJECT_ISSUE_KEY);
      case "a_project":
        return WORLD_PROJECT.url;
      case "a_stray_issue":
        return worldIssueUrl(strayIssueKey(index));
      default: {
        const unreachable: never = link;
        throw new Error(`unhandled tracker link ${String(unreachable)}`);
      }
    }
  }

  /**
   * The author or a polisher pushed to the artifact. The push takes in the base branch, so the
   * host can merge it, and the checks of the new revision start over.
   */
  changeRevision(author: WorldAuthor): void {
    const pull = this.pullOf(author);
    pull.revisionNumber += 1;
    pull.mergeability = "clean";
    pull.headChecks = this.checksOfNewRevision();
    this.installHost();
  }

  /** The author's pull request exists on the host from now on. */
  openPull(author: WorldAuthor): void {
    const pull = this.pullOf(author);
    if (pull.state !== "unopened") return;
    pull.state = "open";
    pull.branch = this.jobOf(author).branch ?? "";
    this.installHost();
  }

  /** The host merged, closed, or reopened the author's pull request. */
  movePull(author: WorldAuthor, state: Exclude<PullState, "unopened">): void {
    this.pullOf(author).state = state;
    this.installHost();
  }

  /** True when the author's pull request is on the host in this state. */
  pullIs(author: WorldAuthor, state: PullState): boolean {
    return author.kind === "pull" && this.pullOf(author).state === state;
  }

  /** The checks report on the head of the author's open pull request. */
  reportChecks(author: WorldAuthor, report: ChecksReport): void {
    this.pullOf(author).headChecks = commitChecksOf(report, this.workflow.now());
    this.installHost();
  }

  /** The host works out again whether the author's open pull request merges into its base. */
  setMergeability(author: WorldAuthor, mergeability: Mergeability): void {
    this.pullOf(author).mergeability = mergeability;
    this.installHost();
  }

  nextStreamedText(): string {
    this.streamedTextCount += 1;
    return `[[${this.streamedTextCount}]]`;
  }

  setTrackerHealth(health: TrackerHealth): void {
    this.tracker.health = health;
  }

  /** Time passes, for every reader of the workflow clock and the host. */
  advanceClock(ms: number): void {
    this.workflow.clock = Math.max(this.workflow.clock ?? 0, Date.now()) + ms;
  }

  /** Run `body` while every call to the page host fails. */
  async whilePageHostIsDown<Result>(body: () => Promise<Result>): Promise<Result> {
    const host = this.workflow.documentsInstance;
    this.workflow.documentsInstance = new FakeDocuments({ failing: true });
    try {
      return await body();
    } finally {
      this.workflow.documentsInstance = host;
    }
  }

  /** Run `body` while the page host refuses to mark any comment read. */
  async whilePageHostRefusesAcknowledgements<Result>(body: () => Promise<Result>): Promise<Result> {
    const host = this.pageHost;
    const acknowledgeComment = host.acknowledgeComment.bind(host);
    host.acknowledgeComment = async () => {
      throw new Error("acknowledgeComment: the host refuses");
    };
    try {
      return await body();
    } finally {
      host.acknowledgeComment = acknowledgeComment;
    }
  }

  /** Run `body` while every call to the host fails. */
  async whileHostIsDown<Result>(body: () => Promise<Result>): Promise<Result> {
    this.hostReadable = false;
    this.installHost();
    try {
      return await body();
    } finally {
      this.hostReadable = true;
      this.installHost();
    }
  }

  /** Run `body` while the host cannot say the head commit of any pull request. */
  async whilePullRevisionsAreUnknown<Result>(body: () => Promise<Result>): Promise<Result> {
    this.pullsReadable = false;
    this.installHost();
    try {
      return await body();
    } finally {
      this.pullsReadable = true;
      this.installHost();
    }
  }

  /** A reviewer run files its review on the author's pull request, against the revision it read. */
  fileReview(
    author: WorldAuthor,
    review: { state: string; body: string; comments: string[] },
  ): void {
    const id = this.nextReviewNumber();
    const pull = this.pullOf(author);
    pull.reviews.push({
      id,
      user: { login: "acme-review[bot]" },
      state: review.state,
      body: review.body,
      commit_id: revisionOf(pull),
      submitted_at: new Date(Date.now() + 60_000).toISOString(),
    });
    this.hostReviewComments[id] = review.comments.map((body, index) => ({
      id: id * 100 + index,
      path: "src/login.ts",
      line: 10 + index,
      original_line: null,
      body: `${body} (review ${id})`,
    }));
    this.installHost();
  }

  /** Run an event that lands in the middle of the running action, and observe the world after it. */
  async land(meanwhile: WorkflowAction): Promise<StepFacts> {
    const facts = (await meanwhile.run(this)) ?? {};
    this.landed.push(this.observe());
    return facts;
  }

  /**
   * Run `body`, and run `meanwhile` while the first sandbox destroy that `body` makes is out. The
   * destroy returns once `meanwhile` ended. The facts are those of both.
   */
  async whileSandboxDestroyed(
    meanwhile: WorkflowAction,
    body: () => Promise<StepFacts | void>,
  ): Promise<StepFacts> {
    const provider = this.workflow.sandboxProvider;
    const destroy = provider.destroy.bind(provider);
    let landedFacts: StepFacts = {};
    provider.destroy = async (sandbox) => {
      provider.destroy = destroy;
      await destroy(sandbox);
      landedFacts = await this.land(meanwhile);
    };
    try {
      const bodyFacts = (await body()) ?? {};
      return { ...bodyFacts, ...landedFacts };
    } finally {
      provider.destroy = destroy;
    }
  }

  /**
   * The decisions model that answers every question from now on. `meanwhile` runs while its
   * first call is out, or its first call that asks the yes-or-no `question`, the way another
   * event lands while the model is asked. A `meanwhile` that did not land during the action
   * that set it is dropped.
   */
  answerDecisionsWith(
    answers: DecisionAnswers,
    meanwhile?: WorkflowAction,
    question?: string,
  ): void {
    const answering = decisionsAnswering(answers);
    const settingAction = this.workBudget.runningStep();
    const landing =
      meanwhile &&
      (async () => {
        if (this.workBudget.runningStep() !== settingAction) return;
        await this.land(meanwhile);
      });
    const decisions = landing
      ? new InterleavedDecisions(
          answering,
          question ? onFirstCallAsking(question, landing) : onFirstCall(landing),
        )
      : answering;
    this.workflow.gatewayInstance = new FakeGateway({ decisions });
  }

  /** A number no review filed in this world had before, for the text that tells reviews apart. */
  nextReviewNumber(): number {
    this.reviewNumber += 1;
    return this.reviewNumber;
  }

  /** The model of a model-call page author answers every call this way from now on. */
  answerPageModelWith(answer: PageModelAnswer): void {
    this.workflow.modelsByName[MODEL_AUTHOR_MODEL] = new TurnEndingModel(
      pageModelAnswering(answer),
      () => this.beforePageModelAnswers(),
    );
  }

  /**
   * Run `start`, and let a person press Stop in the session of `author`'s job while the first
   * page model call of that author is out. The step records the stopped call and every page write
   * from the stop on.
   */
  async stopWhilePageModelAnswers(
    author: WorldAuthor,
    start: () => Promise<void>,
  ): Promise<StepFacts> {
    const session = this.jobSessionOf(author);
    if (!session) return {};
    const host = fakeDocumentsOf(this.workflow);
    const stops: number[] = [];
    this.whilePageModelAnswers = async (taskId) => {
      if (taskId !== author.taskId) return;
      this.whilePageModelAnswers = null;
      stops.push(host.calls.length);
      await this.deliver(stopEvent(session));
    };
    try {
      await start();
    } finally {
      this.whilePageModelAnswers = null;
    }
    const [callsAtStop] = stops;
    if (callsAtStop === undefined) return {};
    const pageWrites = host.calls
      .slice(callsAtStop)
      .map((call) => call.method)
      .filter((method) => PAGE_WRITES.includes(method));
    return {
      authorTurnEnd: { task_id: author.taskId, cancelled: true },
      modelCallStopped: { task_id: author.taskId, pageWrites },
    };
  }

  /**
   * Run `start`, and let a person edit the page of `author` while the first page model call of
   * that author is out. The edit changes the first option line, so a revision that changes that
   * line meets a page it did not read.
   */
  async editPageWhilePageModelAnswers(
    author: WorldAuthor,
    start: () => Promise<void>,
  ): Promise<void> {
    const ref = this.artifactOf(author)?.ref;
    if (ref?.kind !== "page") {
      await start();
      return;
    }
    const edit = `1. Keep one table, as a person edited it at step ${this.steps.length}`;
    this.whilePageModelAnswers = async (taskId) => {
      if (taskId !== author.taskId) return;
      this.whilePageModelAnswers = null;
      const before = this.pageHost.pageText(ref.page_id);
      if (before === undefined) return;
      const after = before.replace(/^1\. Keep one table.*$/m, edit);
      await this.pageHost.updatePageContent(ref.page_id, { before, after });
    };
    try {
      await start();
    } finally {
      this.whilePageModelAnswers = null;
    }
  }

  /**
   * The Durable Object restarts. A new instance over the same store runs the start step, and the
   * alarms it arms for now fire. A call the old instance awaited never answers.
   */
  async restart(): Promise<void> {
    this.workflow = this.workflow.restarted();
    this.hungModelTurns.clear();
    for (const bridge of this.bridges) bridge.reachRestarted(this.workflow);
    await runStartStep(this.workflow);
  }

  /**
   * Run `start`, and restart the workflow while the first page model call of `author` is out.
   * The step records the cut turn.
   */
  async restartWhilePageModelAnswers(
    author: WorldAuthor,
    start: () => Promise<void>,
  ): Promise<StepFacts> {
    const cut = await this.hangPageModelCall(author, start);
    if (!cut) return {};
    await this.restart();
    return { modelTurnCut: cut };
  }

  /**
   * Run `start`, and restart the workflow while the host writes the page of `author`'s first
   * model turn, before or after the host applies the write. A page write of another author's
   * model turn goes through.
   */
  async restartWhileHostWritesPage(
    author: WorldAuthor,
    start: () => Promise<void>,
    applied: "before" | "after",
  ): Promise<StepFacts> {
    const host = fakeDocumentsOf(this.workflow);
    const createPage = host.createPage.bind(host);
    const updatePageContent = host.updatePageContent.bind(host);
    const turnPrompt = this.turnPromptOf(author);
    const modelTurnEndsBefore = this.modelTurnEnds.length;
    let cutTurn: (() => void) | null = null;
    const cut = new Promise<"cut">((resolve) => {
      cutTurn = () => resolve("cut");
    });
    const hang = async <Result>(write: () => Promise<Result>): Promise<Result> => {
      const writer = this.modelTurnEnds.slice(modelTurnEndsBefore).at(-1);
      if (writer !== author.taskId) return write();
      host.createPage = createPage;
      host.updatePageContent = updatePageContent;
      if (applied === "after") await write();
      cutTurn?.();
      return new Promise<never>(() => {});
    };
    host.createPage = (title, text, parent) => hang(() => createPage(title, text, parent));
    host.updatePageContent = (pageId, change) => hang(() => updatePageContent(pageId, change));
    try {
      const outcome = await Promise.race([cut, start().then(() => "ended" as const)]);
      if (outcome !== "cut") return {};
    } finally {
      host.createPage = createPage;
      host.updatePageContent = updatePageContent;
    }
    if (this.modelTurnEnds.at(-1) === author.taskId) this.modelTurnEnds.pop();
    await this.restart();
    return { modelTurnCut: { task_id: author.taskId, prompt_id: turnPrompt } };
  }

  /**
   * Run `start`, hang the first page model call of `author` in this instance, and let the deadline
   * alarm of its turn fire.
   */
  async modelCallOutlivesItsDeadline(
    author: WorldAuthor,
    start: () => Promise<void>,
  ): Promise<StepFacts> {
    const cut = await this.hangPageModelCall(author, start);
    if (!cut) return {};
    const turnId = this.taskOf(author).model_turn_id;
    const deadline = this.workflow
      .alarmsFor("onModelTurnDeadline")
      .find((alarm) => (alarm.payload as ModelTurnAlarm).turn_id === turnId);
    if (!deadline) return {};
    await this.workflow.cancelAlarm(deadline.id);
    await onModelTurnDeadline(this.workflow, deadline.payload as ModelTurnAlarm);
    return { modelTurnCut: cut };
  }

  /**
   * Run `start` until the first page model call of `author` goes out, and hang that call in this
   * instance. Null when no call went out.
   */
  private async hangPageModelCall(
    author: WorldAuthor,
    start: () => Promise<void>,
  ): Promise<{ task_id: string; prompt_id: number | null } | null> {
    let cutTurn: (() => void) | null = null;
    const cut = new Promise<"cut">((resolve) => {
      cutTurn = () => resolve("cut");
    });
    let turnPrompt: number | null = null;
    this.whilePageModelAnswers = async (taskId) => {
      if (taskId !== author.taskId) return;
      this.whilePageModelAnswers = null;
      this.modelTurnEnds.pop();
      turnPrompt = this.turnPromptOf(author);
      this.hungModelTurns.set(taskId, this.taskOf(author).model_turn_id);
      cutTurn?.();
      await new Promise<never>(() => {});
    };
    try {
      const outcome = await Promise.race([cut, start().then(() => "ended" as const)]);
      if (outcome !== "cut") return null;
    } finally {
      this.whilePageModelAnswers = null;
    }
    return { task_id: author.taskId, prompt_id: turnPrompt };
  }

  /** The queued prompt a revise turn of `author` runs on now. Null before its page is out. */
  private turnPromptOf(author: WorldAuthor): number | null {
    if (!this.artifactOf(author)) return null;
    return this.workflow.store.peekPrompt(author.taskId)?.id ?? null;
  }

  /** The tracker session of the author's job, or null when its job has none. */
  private jobSessionOf(author: WorldAuthor): TrackerSession | null {
    const issue = this.jobOf(author).issue_id;
    const sessions = this.workflow.state.reply_targets.filter(
      (target): target is TrackerSession => target.source === "tracker",
    );
    return sessions.find((session) => issue && session.issue_id === issue) ?? null;
  }

  /**
   * A page model call ends the turn of the model-call author whose turn is in flight. A stop
   * armed for that author lands before the model answers.
   */
  private async beforePageModelAnswers(): Promise<void> {
    const { store } = this.workflow;
    const author = store
      .tasks()
      .find(
        (task) =>
          task.role === "author" &&
          task.status === "working" &&
          !store.sandbox(task.task_id) &&
          taskAtWork(this.workflow, task),
      );
    if (!author) return;
    this.modelTurnEnds.push(author.task_id);
    await this.whilePageModelAnswers?.(author.task_id);
  }

  /** The last model-call author turn that ended since `index`, as the step records it. */
  private modelTurnEndSince(index: number): Step["authorTurnEnd"] {
    const taskId = this.modelTurnEnds.slice(index).at(-1);
    return taskId ? { task_id: taskId, cancelled: false } : null;
  }

  /** Deliver one event from a person, the way ingress does. */
  async deliver(event: Pick<InboundEvent, "kind" | "text"> & Partial<InboundEvent>): Promise<void> {
    this.eventNumber += 1;
    const delivered: InboundEvent = {
      id: `evt-${this.eventNumber}`,
      actor: PERSON,
      bindings: [],
      links: [],
      ...event,
    };
    this.delivered = {
      kind: delivered.kind,
      text: delivered.text,
      person: delivered.actor !== null,
      reply_to: delivered.reply_to ?? null,
      control: delivered.control ?? parseVerbalCommand(delivered.text)?.control ?? null,
    };
    await handleEvent(this.workflow, delivered);
  }

  /**
   * A tracker session of the workflow, picked by `index` round the starting session and the
   * sessions on the issues of its jobs. Null when the workflow has none.
   */
  trackerSessionAt(index: number): TrackerSession | null {
    const sessions = this.workflow.state.reply_targets.filter(
      (target): target is TrackerSession => target.source === "tracker",
    );
    return sessions[index % sessions.length] ?? null;
  }

  /** A new chat thread the workflow will reply to from now on. */
  nextChatThread(): ReplyTarget {
    this.chatThreadsJoined += 1;
    return { source: "chat", channel: "C2", thread: `${this.chatThreadsJoined}.0` };
  }

  /** The detail every event about the author's pull request carries. */
  pullDetailOf(author: WorldAuthor): { repo: string; number: number; branch?: string } {
    return {
      repo: REPO,
      number: author.pullNumber,
      branch: this.jobOf(author).branch ?? undefined,
    };
  }

  /** The bindings of an event sent from the author's tracker issue. None for a task without one. */
  issueBindingsOf(author: WorldAuthor): Binding[] {
    const issue = this.jobOf(author).issue_id;
    return issue ? [{ source: "tracker_issue", external_id: issue }] : [];
  }

  /** Fire the provision alarm of a queued task. Its bridge has not dialled in yet. */
  async provisionSandboxOf(taskId: string): Promise<void> {
    const alarm = this.workflow
      .alarmsFor("provision")
      .find((candidate) => (candidate.payload as { task_id: string }).task_id === taskId);
    if (!alarm) return;
    await this.workflow.cancelAlarm(alarm.id);
    await provision(this.workflow, taskId);
  }

  /** Provision a queued task, then let the bridge of its sandbox dial in. */
  async startSandboxOf(taskId: string): Promise<void> {
    await this.provisionSandboxOf(taskId);
    const task = this.workflow.store.requireTask(taskId);
    if (task.status !== "provisioning" || this.workflow.connections(taskId).length) return;
    this.bridges.push(await FakeBridge.connect(this.workflow, task));
  }

  /** The unfinished tasks that wait for a sandbox or for its bridge to dial in. */
  tasksAwaitingSandbox(): TaskRow[] {
    return this.workflow.store
      .tasks()
      .filter(
        (task) =>
          (task.status === "queued" || task.status === "provisioning") &&
          !this.workflow.connections(task.task_id).length,
      );
  }

  private pullOf(author: WorldAuthor): WorldPull {
    const known = this.pulls.get(author.pullNumber);
    if (known) return known;
    const pull: WorldPull = {
      number: author.pullNumber,
      state: "unopened",
      branch: "",
      revisionNumber: 0,
      reviews: [],
      headChecks: this.checksOfNewRevision(),
      mergeability: "clean",
    };
    this.pulls.set(pull.number, pull);
    return pull;
  }

  private checksOfNewRevision(): CommitChecks {
    return this.checksOnPush === "passed" ? PASSED_LONG_AGO : { state: "unreported" };
  }

  /** A job on the branch of a pull request already on the host continues that pull request. */
  private adoptNewAuthors(): void {
    const known = new Set(this.authors.map((author) => author.taskId));
    for (const task of this.workflow.store.tasks()) {
      if (task.role !== "author" || known.has(task.task_id)) continue;
      const job = this.workflow.store.requireJob(task.job_id);
      const kind = kindOfStage(job.stage);
      const continued = [...this.pulls.values()].find(
        (pull) => kind === "pull" && pull.state !== "unopened" && pull.branch === job.branch,
      );
      this.authors.push({
        taskId: task.task_id,
        kind,
        pullNumber: continued?.number ?? this.authors.length + 1,
      });
    }
    this.installHost();
  }

  private installHost(): void {
    const onHost = [...this.pulls.values()].filter((pull) => pull.state !== "unopened");
    this.workflow.codeHostInstance = new FakeCodeHost({
      repositories: [REPO],
      pulls: onHost.map((pull) =>
        pullRequest({
          number: pull.number,
          html_url: pullUrl(pull.number),
          state: pull.state === "open" ? "open" : "closed",
          merged: pull.state === "merged",
          ...MERGEABLE[pull.mergeability],
          head: { ref: pull.branch, sha: revisionOf(pull) },
          base: { ref: BASE_BRANCH },
        }),
      ),
      commitChecks: Object.fromEntries(onHost.map((pull) => [revisionOf(pull), pull.headChecks])),
      reviews: Object.fromEntries(onHost.map((pull) => [pull.number, pull.reviews])),
      reviewComments: this.hostReviewComments,
      failing: !this.hostReadable,
      pullsUnreadable: !this.pullsReadable,
      now: () => this.workflow.now(),
    });
  }

  /** A socket the workflow closed is gone, and the workflow hears that it closed. */
  private async dropClosedSockets(): Promise<void> {
    for (const bridge of this.bridges) {
      if (bridge.open || !this.workflow.sockets.includes(bridge.connection)) continue;
      this.workflow.sockets = this.workflow.sockets.filter(
        (socket) => socket !== bridge.connection,
      );
      const closed = bridge.connection.state as ConnectionState | null;
      if (closed) await onBridgeClosed(this.workflow, closed);
    }
  }

  private promptsSentTo(taskId: string): number {
    return this.bridges
      .filter((bridge) => bridge.taskId === taskId)
      .reduce((total, bridge) => total + bridge.promptsSent, 0);
  }

  /** The id of the newest outbox row, or 0 while the outbox is empty. */
  lastOutboxId(): number {
    return this.lastOutboxRow.get()?.id ?? 0;
  }

  /** The outbox rows written after the row with this id, oldest first. */
  outboxRowsAfter(id: number): OutboxRow[] {
    return this.outboxRowsAfterId.all({ id });
  }

  private observe(): Observation {
    const { store } = this.workflow;
    const authors = new Set(this.authors.map((author) => author.taskId));
    const queue = store.queue();
    const queued = queue.filter((row) => authors.has(row.task_id)).length;
    const sent = this.bridges
      .filter((bridge) => authors.has(bridge.taskId))
      .reduce((total, bridge) => total + bridge.promptsSent, 0);
    const { reply_targets: replyTargets, origin } = this.workflow.state;
    const sessions = replyTargets.filter(
      (target): target is TrackerSession => target.source === "tracker",
    );
    const startingSession = origin?.source === "tracker" ? origin.session_id : null;
    const { stages, definition } = this.workflow.state;
    const declared = definition ? this.workflow.workflowDefinition().stages : [];
    const issueStages = declared
      .filter((stage) => stage.artifact === "issues")
      .map((stage) => stage.name);
    const jobs = store.jobs();
    return {
      subject: this.workflow.state.subject ?? null,
      lastStage: stages.at(-1) ?? null,
      plansIssues: stages.some((stage) => issueStages.includes(stage)),
      jobs: jobs.map((job) => ({
        job_id: job.job_id,
        issue_id: job.issue_id,
        stage: job.stage,
      })),
      workflowStatus: this.workflow.state.status,
      definition: this.workflow.state.definition,
      chatThread: replyTargets.some((target) => target.source === "chat"),
      startingSession,
      jobSessions: Object.fromEntries(
        jobs.map((job) => {
          const onIssue = sessions.find((session) => session.issue_id === job.issue_id);
          return [job.job_id, job.issue_id && onIssue ? onIssue.session_id : null];
        }),
      ),
      posted: store.postedCount(),
      tasks: store.tasks().map((task) => {
        const promptInFlight = store.sandbox(task.task_id)?.prompt_in_flight === 1;
        return {
          task_id: task.task_id,
          role: task.role,
          status: task.status,
          job_id: task.job_id,
          refiner_index: task.refiner_index,
          ruling: decidedRulingOf(store.ruling(task.task_id)),
          turnRunning: promptInFlight && this.runningBridgeOf(task.task_id) !== null,
          promptTexts: [
            ...queue.filter((row) => row.task_id === task.task_id).map((row) => row.text),
            ...this.bridges
              .filter((bridge) => bridge.taskId === task.task_id)
              .flatMap((bridge) => bridge.promptTexts),
            ...(this.modelPromptTexts.get(task.task_id) ?? []),
          ],
          promptsQueued: this.promptsQueuedFor(task.task_id),
          promptsSent:
            this.promptsSentTo(task.task_id) +
            (this.modelPromptTexts.get(task.task_id)?.length ?? 0),
          paused: task.paused_at !== null,
          cancelsSent: this.bridges
            .filter((bridge) => bridge.taskId === task.task_id)
            .reduce((total, bridge) => total + bridge.cancelsSent, 0),
          promptInFlight,
          queuedPrompts: queue.filter((row) => row.task_id === task.task_id).length,
          handshaking: store.handshakePending(task.task_id),
          atWork: !isTaskFinished(task.status) && taskAtWork(this.workflow, task),
          modelCallOut:
            task.model_turn_id !== null &&
            this.hungModelTurns.get(task.task_id) === task.model_turn_id,
        };
      }),
      artifacts: store.artifacts().map((artifact) => ({
        job_id: artifact.job_id,
        status: artifact.status,
        delivered_to_humans_at: artifact.delivered_to_humans_at,
        delivered_revision: artifact.delivered_revision,
      })),
      authorPrompts: queued + sent,
    };
  }
}

type TrackerSession = Extract<ReplyTarget, { source: "tracker" }>;

/** The subject a world that opens on its first job has before that job starts. */
function openingSubject(setup: WorldSetup): Subject | null {
  const fromOrigin = originSubject(ORIGINS[setup.origin]);
  if (fromOrigin) return fromOrigin;
  if (setup.subject === "project") return { kind: "project", project_id: WORLD_PROJECT.id };
  if (setup.firstInput === "origin_issue") return { kind: "issue", issue_id: SUBJECT_ISSUE_KEY };
  return null;
}

const NOT_SESSION_POSTS = ["issue_update", "attach_chat_thread", "delivery_error"];

/** A person presses Stop in a tracker session. */
export function stopEvent(
  session: TrackerSession,
): Pick<InboundEvent, "kind" | "text"> & Partial<InboundEvent> {
  return {
    kind: "stop",
    text: "",
    reply_to: session,
    bindings: [
      { source: "tracker_issue", external_id: session.issue_id },
      { source: "tracker_session", external_id: session.session_id },
    ],
  };
}

function sessionPostsOf(rows: Array<{ channel: string; kind: string; target: unknown }>) {
  return rows.flatMap((row) => {
    if (row.channel !== "tracker" || NOT_SESSION_POSTS.includes(row.kind)) return [];
    const target = row.target as { session_id?: string };
    return target.session_id ? [{ session_id: target.session_id, kind: row.kind }] : [];
  });
}

type OutboxRow = { channel: string; kind: string; target: unknown; payload: unknown };

const NOT_FEED_POSTS = ["plan", "delivery_error"];

function feedPostsOf(rows: OutboxRow[]): Step["feedPosts"] {
  return rows.flatMap((row) => {
    if (row.channel !== "feed" || NOT_FEED_POSTS.includes(row.kind)) return [];
    const post = row.payload as { task_id: string; content: AgentActivityContent };
    return [{ task_id: post.task_id, kind: row.kind, text: activityText(post.content) }];
  });
}

function kindOfStage(stage: string): ArtifactKind {
  const kinds = Object.keys(STAGE_OF) as ArtifactKind[];
  const kind = kinds.find((candidate) => STAGE_OF[candidate] === stage);
  if (!kind) throw new Error(`no artifact kind for stage ${stage}`);
  return kind;
}

/** The URL of the world's document page numbered `number`. */
export function pageUrl(number: number): string {
  return `https://www.notion.so/acme/page-${number}`;
}

function pageHost(): FakeDocuments {
  const numbers = Array.from({ length: MAX_PAGES }, (_unused, index) => index + 1);
  const documents = new FakeDocuments({
    pages: Object.fromEntries(numbers.map((number) => [pageUrl(number), `page-${number}`])),
    held: [HELD_COMMENT],
  });
  for (const number of numbers) documents.seedPage(`page-${number}`, PAGE_TEXT);
  return documents;
}

/** The page answer of a model-call author: page text, then the closing text a revise needs. */
const PAGE_MODEL_ANSWER = `${PAGE_TEXT}\n\n${CLOSING_TEXT_MARKER}\nRevised the page.`;

/** The most calls a throwing page model fails. More than any sequence makes. */
const PAGE_MODEL_FAILURES = 100;

/** The page answer with a reply to each page comment the prompt labels. */
function pageModelAnswerReplying(userText: string): string {
  const replies = labeledPageCommentIds(userText).map(
    (commentId) => `${replyMarker(commentId)}\nAnswered in the revision.`,
  );
  return [PAGE_MODEL_ANSWER, ...replies].join("\n");
}

function pageModelAnswering(answer: PageModelAnswer): LanguageModelV4 {
  switch (answer) {
    case "page":
      return new EchoModel(pageModelAnswerReplying);
    case "skips_replies":
      return new EchoModel(PAGE_MODEL_ANSWER);
    case "blank":
      return new EchoModel("  ");
    case "throws":
      return new ScriptedFailure(
        Array.from({ length: PAGE_MODEL_FAILURES }, () => "throw" as const),
      );
    default: {
      const unreachable: never = answer;
      throw new Error(`unhandled page model answer ${String(unreachable)}`);
    }
  }
}

/** A page model that tells the world each time a call ends a model-call author's turn, before it answers. */
class TurnEndingModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "turn-ending";
  readonly supportedUrls = {};

  constructor(
    private readonly answering: LanguageModelV4,
    private readonly beforeAnswer: () => Promise<void>,
  ) {}

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    await this.beforeAnswer();
    return await this.answering.doGenerate(options);
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return await this.answering.doStream(options);
  }
}

/** Run the author of the page stage as model calls. The world installs the page model. */
function patchModelPageAuthor(workflow: FakeRuntime): void {
  workflow.patchState({ page_parent: PAGE_PARENT });
  workflow.patchWorkflowDefinition({
    stages: workflow.workflowDefinition().stages.map((stage) =>
      stage.name === STAGE_OF.page
        ? {
            ...stage,
            author: {
              produce: {
                execution: "model" as const,
                model: MODEL_AUTHOR_MODEL,
                effort: stage.author.produce.effort,
                skill: stage.author.produce.skill,
                preload_skills: [],
              },
            },
          }
        : stage,
    ),
  });
}

function patchPageEnding(workflow: FakeRuntime, ending: PageEnding): void {
  workflow.patchWorkflowDefinition({
    stages: workflow
      .workflowDefinition()
      .stages.map((stage) => (stage.name === STAGE_OF.page ? { ...stage, ending } : stage)),
  });
}

function pullUrl(number: number): string {
  return `https://github.com/${REPO}/pull/${number}`;
}

function revisionOf(pull: WorldPull): string {
  return `rev-${pull.number}-${pull.revisionNumber}`;
}

/** How many pushes came before a revision of a world pull request, read from its name. */
export function pushCountOf(revision: string): number {
  return Number(revision.slice(revision.lastIndexOf("-") + 1));
}

const PASSED_LONG_AGO: CommitChecks = { state: "passed", settled_at: new Date(0).toISOString() };

const MERGEABLE: Record<Mergeability, { mergeable: boolean | null; mergeable_state: string }> = {
  clean: { mergeable: true, mergeable_state: "clean" },
  conflicted: { mergeable: false, mergeable_state: "dirty" },
  unknown: { mergeable: null, mergeable_state: "unknown" },
};

function commitChecksOf(report: ChecksReport, now: number): CommitChecks {
  switch (report) {
    case "unreported":
    case "running":
      return { state: report };
    case "failed":
      return { state: "failed", failures: [FAILED_CHECK] };
    case "stopped":
      return { state: "stopped", failures: [STOPPED_CHECK] };
    case "passed_just_now":
      return { state: "passed", settled_at: new Date(now).toISOString() };
    case "passed_long_ago":
      return PASSED_LONG_AGO;
    default: {
      const unreachable: never = report;
      throw new Error(`unhandled checks report ${String(unreachable)}`);
    }
  }
}

/** Milliseconds a hanging decisions model gets before its call is abandoned, so a hang stays fast. */
const HANGING_DECISIONS_DEADLINE_MS = 5;

function decisionsAnswering(answers: DecisionAnswers): Decisions {
  switch (answers) {
    case "fails":
      return new FakeDecisions(new Error("decisions model unavailable"));
    case "hangs":
      return new HangingDecisions(HANGING_DECISIONS_DEADLINE_MS);
    default: {
      const { selected, outcome, ...probabilities } = answers;
      return new FakeDecisions(probabilities, {
        ...(selected ? { selected } : {}),
        ...(outcome ? { outcome } : {}),
      });
    }
  }
}
