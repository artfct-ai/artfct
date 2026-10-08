import type {
  CheckFailure,
  CommitChecks,
  PullRequestReview,
  PullRequestReviewComment,
} from "@artfct-ai/adapters/code/types";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions, HangingDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { RefinerEntry, ReviewerEntry } from "../src/config/refiner";
import { startJob } from "../src/workflow/lifecycle";
import { handleEvent } from "../src/workflow/inbound/events";
import { isTaskFinished } from "../src/workflow/store/state";
import type { ArtifactRow, JobRow, TaskRow } from "../src/workflow/store/tasks";
import { onBridgeClosed, type ConnectionState } from "../src/workflow/task/harness/bridge";
import { provision } from "../src/workflow/task/sandbox/sandbox";
import { acceptingD1 } from "./accepting-d1";
import { FakeBridge } from "./fake-bridge";
import {
  FakeRuntime,
  JUDGE_ENTRY,
  patchStagePolishers,
  patchStageResearch,
  patchStageReviewers,
} from "./fake-runtime";
import type { Observation, Step } from "./invariants";
import { openMemoryDb } from "./memory-db";
import { testEnv } from "./test-env";

/** The refiner lists a world can declare on its stages. */
export const REFINER_SETUPS = [
  "none",
  "reviewer",
  "judge",
  "judge_between_reviewers",
  "reviewer_then_polisher",
  "polisher",
  "judge_then_polisher",
] as const;

export type RefinerSetup = (typeof REFINER_SETUPS)[number];

/**
 * What one generated world is made of: the artifact kind of its first task, its refiner lists,
 * whether its stages run a researcher before the author, and what the checks say on a new push.
 */
export type WorldSetup = {
  artifact: ArtifactKind;
  refiners: RefinerSetup;
  research: boolean;
  checksOnPush: ChecksOnPush;
};

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
export type ArtifactKind = "pull" | "issues";

/** The stage whose tasks produce each artifact kind. */
export const STAGE_OF: Record<ArtifactKind, string> = { pull: "implement", issues: "breakdown" };

/** The most author tasks the agent tries to hold in one world. It is more than the slots. */
export const MAX_AUTHORS = 4;

/** The task slots of the workflow of a world. */
export const SLOTS = 2;

/** The texts a person asks for ad hoc work with. The first one started the world's first job. */
export const REQUEST_TEXTS = ["Fix the login redirect.", "Add a logout link."] as const;

/** The repository of the workflow of a world. */
export const REPO = "acme/app";

/** What an action tells the world about itself, for the step record. */
export type StepFacts = Partial<
  Pick<
    Step,
    | "authorTurnEnd"
    | "feedback"
    | "refinerTurnEnd"
    | "staleAlarm"
    | "completion"
    | "unadmittedFeedback"
  >
>;

/** One thing that happens to a workflow. It picks its target from the world and may do nothing. */
export type WorkflowAction = {
  run(world: WorkflowWorld): Promise<StepFacts | void>;
  toString(): string;
};

/**
 * The probabilities a decisions model answers with, a model whose every call fails, one that
 * never answers before its caller's signal aborts, or a gateway without a decisions model.
 */
export type DecisionAnswers =
  | {
      for_author: number;
      beyond_author: number;
      rejects: number;
      gave_up?: number;
      accepts?: number;
    }
  | "fails"
  | "hangs"
  | "none";

/**
 * One author task and the number of its artifact on the host. An author that continues an open
 * pull request shares its number with the author that opened it. Every other author has its own.
 */
export type WorldAuthor = { taskId: string; kind: ArtifactKind; pullNumber: number };

/** A pull request in the workflow's repository that no task of the workflow opened. */
export const UNOWNED_PULL = { repo: REPO, number: 99, branch: "someone/else" };

const PERSON = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

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
  reviewer_then_polisher: { reviewers: [FINDINGS_REVIEWER], polishers: [POLISHER] },
  polisher: { reviewers: [], polishers: [POLISHER] },
  judge_then_polisher: { reviewers: [JUDGE_ENTRY], polishers: [POLISHER] },
};

/**
 * One workflow with its author tasks, a code host, and the sandboxes of its tasks. Actions change
 * it through the entry points production uses, and every step is recorded for the invariants.
 */
export class WorkflowWorld {
  readonly workflow: FakeRuntime;
  readonly steps: Step[] = [];
  readonly authors: WorldAuthor[] = [];
  private readonly pulls = new Map<number, WorldPull>();
  private readonly bridges: FakeBridge[] = [];
  private readonly promptsAtNormalTurnEnd = new Map<string, number>();
  private hostReadable = true;
  private hostReviewComments: Record<number, PullRequestReviewComment[]> = {};
  private reviewNumber = 0;
  private eventNumber = 0;
  private delivered: Step["event"] = null;
  private readonly checksOnPush: ChecksOnPush;

  private constructor(workflow: FakeRuntime, checksOnPush: ChecksOnPush) {
    this.workflow = workflow;
    this.checksOnPush = checksOnPush;
  }

  /** A running workflow whose first author or researcher task works on its first prompt. */
  static async open(setup: WorldSetup): Promise<WorkflowWorld> {
    const workflow = new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: acceptingD1() });
    const lists = REFINER_LISTS[setup.refiners];
    patchStageReviewers(workflow, lists.reviewers);
    patchStagePolishers(workflow, lists.polishers);
    if (setup.research) patchStageResearch(workflow);
    workflow.gatewayInstance = new FakeGateway();
    workflow.patchState({
      repo: { full: REPO },
      request: { title: "Fix login", text: "Fix the login redirect.", links: [] },
      reply_targets: [{ source: "chat", channel: "C1", thread: "1.0" }],
      concurrency: SLOTS,
    });
    const stage = STAGE_OF[setup.artifact];
    const first = await startJob(workflow, {
      stage,
      brief: "Fix the login redirect.",
      input: { kind: "request", text: REQUEST_TEXTS[0] },
    });
    if (!first) throw new Error(`the test config declares no stage ${stage}`);
    const world = new WorkflowWorld(workflow, setup.checksOnPush);
    world.adoptNewAuthors();
    await world.startSandboxOf(workflow.store.authorOrResearcherTaskOf(first.job_id).task_id);
    return world;
  }

  /** Run one action and record what an observer saw around it. */
  async apply(action: WorkflowAction): Promise<Step> {
    const before = this.steps.at(-1)?.after ?? this.observe();
    const notesBefore = this.workflow.notes.length;
    this.delivered = null;
    const facts = (await action.run(this)) ?? {};
    this.adoptNewAuthors();
    await this.dropClosedSockets();
    const ended = facts.refinerTurnEnd?.task_id;
    if (ended && !this.runningBridgeOf(ended)) {
      this.promptsAtNormalTurnEnd.set(ended, this.promptsSentTo(ended));
    }
    const step: Step = {
      action: String(action),
      before,
      after: this.observe(),
      notes: this.workflow.notes.slice(notesBefore),
      authorTurnEnd: facts.authorTurnEnd ?? null,
      feedback: facts.feedback ?? null,
      refinerTurnEnd: facts.refinerTurnEnd ?? null,
      staleAlarm: facts.staleAlarm ?? null,
      completion: facts.completion ?? null,
      unadmittedFeedback: facts.unadmittedFeedback ?? null,
      event: this.delivered,
    };
    this.steps.push(step);
    return step;
  }

  /** The author an action is about, or null before any author exists. `index` counts round them. */
  authorAt(index: number): WorldAuthor | null {
    return this.authors[index % this.authors.length] ?? null;
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
    if (author.kind !== "pull" || pull.state === "unopened" || !this.hostReadable) return null;
    return revisionOf(pull);
  }

  /** True when an earlier author opened the pull request this author works on. */
  continuesPull(author: WorldAuthor): boolean {
    return this.authors.find((other) => other.pullNumber === author.pullNumber) !== author;
  }

  /** The link an author prints when it opens its artifact. */
  artifactUrlOf(author: WorldAuthor): string {
    return author.kind === "pull"
      ? pullUrl(author.pullNumber)
      : `https://linear.app/acme/issue/ENG-4${author.pullNumber}/fix-login`;
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

  /** Time passes, for every reader of the workflow clock and the host. */
  advanceClock(ms: number): void {
    this.workflow.clock = Math.max(this.workflow.clock ?? 0, Date.now()) + ms;
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

  /** A reviewer run files its review on the author's pull request, against the revision it read. */
  fileReview(
    author: WorldAuthor,
    review: { state: string; body: string; comments: string[] },
  ): void {
    this.reviewNumber += 1;
    const id = this.reviewNumber;
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
      body,
    }));
    this.installHost();
  }

  /** The decisions model that answers every question from now on. */
  answerDecisionsWith(answers: DecisionAnswers): void {
    this.workflow.gatewayInstance = new FakeGateway({ decisions: decisionsAnswering(answers) });
  }

  /** Deliver one event from a person, the way ingress does. */
  async deliver(event: Pick<InboundEvent, "kind" | "text"> & Partial<InboundEvent>): Promise<void> {
    this.eventNumber += 1;
    this.delivered = { kind: event.kind };
    await handleEvent(this.workflow, {
      id: `evt-${this.eventNumber}`,
      actor: PERSON,
      bindings: [],
      links: [],
      ...event,
    });
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
      const kind = job.stage === STAGE_OF.pull ? "pull" : "issues";
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

  private observe(): Observation {
    const { store } = this.workflow;
    const authors = new Set(this.authors.map((author) => author.taskId));
    const queued = store.queue().filter((row) => authors.has(row.task_id)).length;
    const sent = this.bridges
      .filter((bridge) => authors.has(bridge.taskId))
      .reduce((total, bridge) => total + bridge.promptsSent, 0);
    return {
      workflowStatus: this.workflow.state.status,
      tasks: store.tasks().map((task) => ({
        task_id: task.task_id,
        role: task.role,
        status: task.status,
        job_id: task.job_id,
        refiner_index: task.refiner_index,
        ruling: task.result?.kind === "ruling" ? JSON.stringify(task.result) : null,
        quietSinceTurnEnd:
          this.promptsAtNormalTurnEnd.get(task.task_id) === this.promptsSentTo(task.task_id),
      })),
      artifacts: store.artifacts().map((artifact) => ({
        job_id: artifact.job_id,
        status: artifact.status,
        delivered_to_humans_at: artifact.delivered_to_humans_at,
        delivered_revision: artifact.delivered_revision,
      })),
      todos: Object.fromEntries(
        store.allTodoRows().map((row) => [row.task_id, JSON.stringify(row.todos)]),
      ),
      authorPrompts: queued + sent,
    };
  }
}

function pullUrl(number: number): string {
  return `https://github.com/${REPO}/pull/${number}`;
}

function revisionOf(pull: WorldPull): string {
  return `rev-${pull.number}-${pull.revisionNumber}`;
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

function decisionsAnswering(answers: DecisionAnswers): Decisions | undefined {
  switch (answers) {
    case "fails":
      return new FakeDecisions(new Error("decisions model unavailable"));
    case "hangs":
      return new HangingDecisions();
    case "none":
      return undefined;
    default:
      return new FakeDecisions(answers);
  }
}
