import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { RpcAck, TaskStatus } from "@artfct-ai/contracts/types";
import type { AgentActivityContent } from "@artfct-ai/adapters/tracker/types";
import { channelTools } from "../src/agent/tools/channel";
import { planTools } from "../src/agent/tools/plan";
import { startTools } from "../src/agent/tools/start/start";
import { armTurnWatchdog, onTurnTimeout } from "../src/agent/turn/watchdog";
import { flushBoards } from "../src/workflow/board/board";
import { onIdle } from "../src/workflow/lifecycle";
import { DONE_TEXT, STOPPED_TEXT } from "../src/workflow/feed/feed";
import { isTaskFinished, isWorkflowFinished, type Subject } from "../src/workflow/store/state";
import type { TaskRow } from "../src/workflow/store/tasks";
import { onWallClock } from "../src/workflow/task/harness/timers";
import type { TaskEvent } from "../src/workflow/task/events";
import type { WorkflowRuntime } from "../src/workflow/types";
import { Deferred } from "./deferred";
import { FakeRuntime } from "./fake-runtime";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import type { TrackerHealth } from "./session-tracker";
import {
  agentHoldsAuthor,
  authorPromptFails,
  authorReportsTodos,
  authorStreams,
  authorTurnEnds,
  chatThreadJoins,
  firstArtifactAppears,
  personStopsModelCall,
  researcherReportsTodos,
  researcherTurnEnds,
  type AuthorClosing,
} from "./workflow-actions";
import {
  pageUrl,
  REPO,
  STAGE_OF,
  stopEvent,
  WorkflowWorld,
  type WorkflowAction,
  type WorldSetup,
} from "./workflow-world";
import { SUBJECT_ISSUE_KEY, subIssueKey, WORLD_PROJECT, worldIssueUrl } from "./world-tracker";

/** The setup modules of the session routing spec: where each workflow starts, and who authors. */
export const SPEC_SETUPS = {
  chatThread: { origin: "chat", research: false, pageAuthor: "harness" },
  trackerOnly: { origin: "tracker", research: false, pageAuthor: "harness" },
  trackerResearch: { origin: "tracker", research: true, pageAuthor: "harness" },
  trackerModelCall: { origin: "tracker", research: false, pageAuthor: "model" },
  trackerPause: { origin: "tracker", research: false, pageAuthor: "harness" },
  trackerDelivery: { origin: "tracker", research: false, pageAuthor: "harness" },
} as const satisfies Record<string, Pick<WorldSetup, "origin" | "research" | "pageAuthor">>;

/** The name of one setup module of the spec. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

const TRACE_STEPS = 25;

const ISSUES = ["SubjectIssue", "SubIssue"] as const;
const SUBJECTS = ["NoSubject", "IssueSubject", "ProjectSubject"] as const;
const AUTHOR_STATUSES = ["NotStarted", "InTurn", "Idle", "InReview", "Finished"] as const;
const RESEARCH_STATES = [
  "NoResearch",
  "Researching",
  "Researched",
  "ResearchCancelled",
  "ResearchFailed",
] as const;
const POST_KINDS = [
  "QuestionPost",
  "ArtifactReadyPost",
  "FailedPost",
  "WorkflowFailedPost",
  "DonePost",
  "StatusPost",
  "InfoPost",
  "TurnFailedPost",
] as const;
const FEED_KINDS = [
  "ActionActivity",
  "ReplyActivity",
  "DoneActivity",
  "StoppedActivity",
  "ErrorActivity",
] as const;
const SESSION_TEXTS = ["Question", "StatusRequest", "PauseCommand", "CancelCommand"] as const;
const OUTCOMES = ["Answers", "Asks", "TimesOut"] as const;
const ENDINGS = ["Finishes", "Fails"] as const;
const TURN_ENDINGS = [
  "Replies",
  "EndsSilently",
  "StopsEarly",
  "GivesUp",
  "PromptFails",
  "Cancelled",
] as const;
const STREAMED = ["Message", "ToolCall"] as const;
const HEALTHS = ["TrackerUp", "FailsBeforeStoring", "FailsAfterStoring"] as const;

type Issue = (typeof ISSUES)[number];
type SpecSubject = (typeof SUBJECTS)[number];
type PostKind = (typeof POST_KINDS)[number];
type FeedKind = (typeof FEED_KINDS)[number];
type SessionText = (typeof SESSION_TEXTS)[number];
type Outcome = (typeof OUTCOMES)[number];
type Ending = (typeof ENDINGS)[number];
type TurnEnding = (typeof TURN_ENDINGS)[number];
type Streamed = (typeof STREAMED)[number];
type Health = (typeof HEALTHS)[number];

/** The tracker issue key of each issue of the spec. */
const ISSUE_KEY: Record<Issue, string> = {
  SubjectIssue: SUBJECT_ISSUE_KEY,
  SubIssue: subIssueKey(0),
};

/** The link a plan names for each subject of the spec that a plan can name. */
const SUBJECT_LINK: Record<Exclude<SpecSubject, "NoSubject">, string> = {
  IssueSubject: worldIssueUrl(SUBJECT_ISSUE_KEY),
  ProjectSubject: WORLD_PROJECT.url,
};

/** The chat channel of each chat thread of the spec, by number. */
const CHAT_CHANNELS = ["C1", "C2"];

/** How the world's tracker answers for each tracker health of the spec. */
const TRACKER_HEALTH: Record<Health, TrackerHealth> = {
  TrackerUp: "up",
  FailsBeforeStoring: "fails_before_storing",
  FailsAfterStoring: "fails_after_storing",
};

/** The closing text the author's turn ends with for each turn ending of the spec that is a turn end. */
const CLOSING_OF: Record<Exclude<TurnEnding, "PromptFails">, AuthorClosing> = {
  Replies: "finished",
  EndsSilently: "silent",
  StopsEarly: "stopped_early",
  GivesUp: "blocked",
  Cancelled: "finished",
};

/** A todo list by how many of its entries are complete. Null when none was reported. */
type SpecTodos = number | null;

/** One job as the spec sees it. */
type SpecJob = {
  issue: Issue;
  author: (typeof AUTHOR_STATUSES)[number];
  queued: number;
  handedOver: boolean;
  buffered: boolean;
  todos: SpecTodos;
  restarts: number;
  stoppedEarly: boolean;
  containerClosed: boolean;
  paused: boolean;
  cancelSent: boolean;
  research: (typeof RESEARCH_STATES)[number];
  researcherTodos: SpecTodos;
};

/** One post and the reply targets it reached, each target by its spec name. */
type SpecPost = { kind: PostKind; targets: string[] };

/** One feed activity: the job it belongs to, its kind, and how many the tracker stored. */
export type SpecFeedPost = { job: number; kind: FeedKind; stored: number };

/** What one step sent out: its posts, its feed activities by job, and the sessions of its plans. */
export type SpecOutput = { posts: SpecPost[]; feed: SpecFeedPost[]; plans: Issue[] };

/** The workflow as the spec sees it. Targets go by their spec names, and sets are sorted. */
export type SpecRouting = {
  subject: SpecSubject;
  replyTargets: string[];
  jobs: SpecJob[];
  waiting: string[];
  links: Issue[];
  boards: string[];
  waitsForInput: boolean;
  ended: boolean;
};

/** The deliveries of one session message in flight, and whether it was marked seen. */
export type SpecMessage = { inFlight: number; seen: boolean };

/** The values the spec picked for one action. */
export type SpecPicks = {
  subject: SpecSubject | null;
  issue: Issue | null;
  text: SessionText | null;
  outcome: Outcome | null;
  id: number | null;
  ending: Ending | null;
  turnEnding: TurnEnding | null;
  streamed: Streamed | null;
  health: Health | null;
  todos: number | null;
  message: number | null;
};

/**
 * One state of a trace: the action that led to it, its picks, what its step sent, the workflow,
 * and the session messages that waited on the idle clock. A pinned trace that predates them has
 * none.
 */
export type TraceStep = {
  action: string;
  picks: SpecPicks;
  output: SpecOutput;
  routing: SpecRouting;
  messages: SpecMessage[] | null;
};

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces(
    {
      spec: "session-routing",
      setup,
      count,
      steps: TRACE_STEPS,
      seed,
    },
    (trace) => traceSteps(setup, trace),
  );
}

/** The steps of one spec trace, given as its ITF JSON, run on one setup. */
export function traceSteps(setup: SpecSetup, trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const picks = itfField(state, "mbt::nondetPicks");
    const pickOf = (name: string) => {
      const pick = itfVariant(itfField(picks, name, true));
      return pick?.tag === "Some" ? pick.value : null;
    };
    const picked = <Name extends string>(name: string, names: readonly Name[]) => {
      const value = pickOf(name);
      return value === null ? null : itfOneOf(itfVariant(value)!.tag, names);
    };
    const id = pickOf("id");
    const todos = pickOf("todos");
    const message = pickOf("message");
    const messages = itfField(state, `${setup}::sessionRouting::sessionMessages`, true);
    const facts = itfField(state, `${setup}::sessionRouting::lastStep`);
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        subject: picked("subject", SUBJECTS),
        issue: picked("issue", ISSUES),
        text: picked("text", SESSION_TEXTS),
        outcome: picked("outcome", OUTCOMES),
        id: id === null ? null : itfInt(id),
        ending: picked("ending", ENDINGS),
        turnEnding: picked("turnEnding", TURN_ENDINGS),
        streamed: picked("streamed", STREAMED),
        health: picked("health", HEALTHS),
        todos: todos === null ? null : specTodos(todos),
        message: message === null ? null : itfInt(message),
      },
      output: {
        posts: itfList(itfField(facts, "posts")).map((post) => ({
          kind: itfOneOf(itfVariant(itfField(post, "kind"))!.tag, POST_KINDS),
          targets: itfSet(itfField(post, "targets")).map(specTargetName).toSorted(),
        })),
        feed: byJob(
          itfList(itfField(facts, "feed")).map((posted) => ({
            job: itfInt(itfField(posted, "job")),
            kind: itfOneOf(itfVariant(itfField(posted, "kind"))!.tag, FEED_KINDS),
            stored: itfInt(itfField(posted, "stored")),
          })),
        ),
        plans: itfList(itfField(facts, "plans"))
          .map((issue) => itfOneOf(itfVariant(issue)!.tag, ISSUES))
          .toSorted(),
      },
      routing: specRouting(itfField(state, `${setup}::sessionRouting::routing`)),
      messages: messages === null ? null : specMessages(messages),
    };
  });
}

function specMessages(value: unknown): SpecMessage[] {
  return itfList(itfField(value, "#map"))
    .map((pair) => {
      const [message, sent] = itfList(pair);
      return { message: itfInt(message), sent };
    })
    .toSorted((left, right) => left.message - right.message)
    .map(({ sent }) => ({
      inFlight: itfInt(itfField(sent, "inFlight")),
      seen: itfInt(itfField(sent, "landed")) > 0,
    }));
}

function byJob(feed: SpecFeedPost[]): SpecFeedPost[] {
  return feed.toSorted((left, right) => left.job - right.job);
}

function specTodos(value: unknown): SpecTodos {
  const list = itfVariant(value)!;
  return list.tag === "Todos" ? itfInt(list.value) : null;
}

function specTargetName(value: unknown): string {
  const target = itfVariant(value)!;
  if (target.tag === "ChatThread") return `ChatThread(${itfInt(target.value)})`;
  return `Session(${itfOneOf(itfVariant(target.value)!.tag, ISSUES)})`;
}

function specRouting(value: unknown): SpecRouting {
  return {
    subject: itfOneOf(itfVariant(itfField(value, "subject"))!.tag, SUBJECTS),
    replyTargets: itfSet(itfField(value, "replyTargets")).map(specTargetName).toSorted(),
    jobs: itfList(itfField(value, "jobs")).map((job) => ({
      issue: itfOneOf(itfVariant(itfField(job, "issue"))!.tag, ISSUES),
      author: itfOneOf(itfVariant(itfField(job, "author"))!.tag, AUTHOR_STATUSES),
      queued: itfInt(itfField(job, "queued")),
      handedOver: itfBool(itfField(job, "handedOver")),
      buffered: itfBool(itfField(job, "buffered")),
      todos: specTodos(itfField(job, "todos")),
      restarts: itfInt(itfField(job, "restarts")),
      stoppedEarly: itfBool(itfField(job, "stoppedEarly")),
      containerClosed: itfBool(itfField(job, "containerClosed")),
      paused: itfBool(itfField(job, "paused")),
      cancelSent: itfBool(itfField(job, "cancelSent")),
      research: itfOneOf(itfVariant(itfField(job, "research"))!.tag, RESEARCH_STATES),
      researcherTodos: specTodos(itfField(job, "researcherTodos")),
    })),
    waiting: itfSet(itfField(value, "waiting")).map(specTargetName).toSorted(),
    links: itfList(itfField(value, "links")).map((issue) =>
      itfOneOf(itfVariant(issue)!.tag, ISSUES),
    ),
    boards: itfSet(itfField(value, "boards"))
      .map((board) => `${itfInt(itfField(board, "job"))}@${itfInt(itfField(board, "thread"))}`)
      .toSorted(),
    waitsForInput: itfBool(itfField(value, "waitsForInput")),
    ended: itfBool(itfField(value, "ended")),
  };
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const REQUEST_TEXT = "Fix the login redirect.";
const STAGE = STAGE_OF.page;

const WORLD_SETUP: Omit<WorldSetup, "origin" | "research" | "pageAuthor"> = {
  opening: "request",
  artifact: "page",
  refiners: "none",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  firstInput: "request",
  subject: "none",
  sandboxStart: "at_task_start",
  pageBranch: false,
};

/** What a person types in a tracker session for each session text of the spec. */
const SESSION_EVENTS: Record<SessionText, { kind: "prompt" | "status"; text: string }> = {
  Question: { kind: "prompt", text: "Why does the redirect skip the check?" },
  StatusRequest: { kind: "status", text: "status?" },
  PauseCommand: { kind: "prompt", text: "pause" },
  CancelCommand: { kind: "prompt", text: "cancel" },
};

const POST_KIND_OF: Partial<Record<TaskEvent["type"], PostKind>> = {
  question: "QuestionPost",
  artifact_ready: "ArtifactReadyPost",
  failed: "FailedPost",
  workflow_failed: "WorkflowFailedPost",
  done: "DonePost",
  status: "StatusPost",
  info: "InfoPost",
  turn_failed: "TurnFailedPost",
};

const RESEARCH_OF: Record<TaskStatus, SpecJob["research"]> = {
  queued: "Researching",
  provisioning: "Researching",
  working: "Researching",
  in_review: "Researching",
  done: "Researched",
  cancelled: "ResearchCancelled",
  failed: "ResearchFailed",
};

const NOT_FEED_ACTIVITIES = ["plan", "delivery_error"];

function worldAction(label: string, run: (world: WorkflowWorld) => Promise<void>): WorkflowAction {
  return { run, toString: () => label };
}

function issueOfKey(key: string | null): Issue {
  const issue = ISSUES.find((candidate) => ISSUE_KEY[candidate] === key);
  if (!issue) throw new Error(`the spec has no issue for ${String(key)}`);
  return issue;
}

function targetName(target: ReplyTarget): string {
  if (target.source === "tracker") return `Session(${issueOfKey(target.issue_id)})`;
  if (target.source !== "chat") throw new Error(`the spec has no target ${JSON.stringify(target)}`);
  const thread = CHAT_CHANNELS.indexOf(target.channel);
  if (thread === -1) throw new Error(`the spec has no chat thread in ${target.channel}`);
  return `ChatThread(${thread})`;
}

function threadOfBoardKey(key: string): number {
  const thread = CHAT_CHANNELS.findIndex((channel) => key.startsWith(`chat:${channel}:`));
  if (thread === -1) throw new Error(`the spec has no chat thread for the board ${key}`);
  return thread;
}

function issueKeyOfTarget(target: unknown): string | null {
  if (typeof target !== "object" || target === null || !("issue_id" in target)) return null;
  return typeof target.issue_id === "string" ? target.issue_id : null;
}

function feedKindOf(content: AgentActivityContent): FeedKind {
  if (content.type === "action") return "ActionActivity";
  if (content.type === "error") return "ErrorActivity";
  if (content.type !== "response") throw new Error(`the spec has no feed kind ${content.type}`);
  if (content.body === STOPPED_TEXT) return "StoppedActivity";
  if (content.body === DONE_TEXT) return "DoneActivity";
  return "ReplyActivity";
}

/** The fields of a feed row the notifier wrote: its task, its activity id, and its content. */
type FeedPayload = { task_id: string; id: string; content: AgentActivityContent };

function feedPayloadOf(payload: unknown): FeedPayload {
  if (typeof payload !== "object" || payload === null) throw new Error("a feed row has no payload");
  return payload as FeedPayload;
}

function todosOf(workflow: WorkflowRuntime, task: TaskRow | null): SpecTodos {
  if (!task) return null;
  const entries = workflow.store.todoRow(task.task_id)?.todos?.entries ?? [];
  if (!entries.length) return null;
  return entries.filter((entry) => entry.status === "completed").length;
}

/** A delivery that waits on the idle clock until the trace lands it. */
type HeldDelivery = { land: () => void; outcome: Promise<RpcAck> };

/** A session message a person sent, and its deliveries that wait on the idle clock. */
type SentMessage = {
  event: Pick<InboundEvent, "id" | "kind" | "text" | "reply_to" | "bindings">;
  held: HeldDelivery[];
};

/** The next delivery to reach the idle clock: it says it arrived and waits to land. */
type IdleClockGate = { arrived: () => void; landed: Promise<void> };

/**
 * Replays session routing traces through a workflow world that starts in a chat thread or in a
 * tracker session. Each spec action maps to the entry point production uses. The agent turn
 * runs as its tools and its watchdog would: it takes the inbox, posts, and deletes what it took.
 */
export class SessionRoutingReplay {
  private readonly sent: SentMessage[] = [];
  private readonly gates: { next: IdleClockGate | null } = { next: null };

  private constructor(readonly world: WorkflowWorld) {}

  /** A started world of `setup`. A chat workflow's plan does not name a subject yet. */
  static async open(setup: SpecSetup): Promise<SessionRoutingReplay> {
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, ...SPEC_SETUPS[setup] });
    const { workflow } = world;
    const recordNote = workflow.tellAgent.bind(workflow);
    workflow.tellAgent = async (text, wake, from) => {
      workflow.transcript.enqueue(text, wake, from);
      await recordNote(text, wake, from);
    };
    const replay = new SessionRoutingReplay(world);
    const { gates } = replay;
    workflow.scheduleAlarm = async function scheduleBehindTheGate(this: FakeRuntime, ...alarm) {
      const gate = alarm[1] === "onIdle" ? gates.next : null;
      if (gate) {
        gates.next = null;
        gate.arrived();
        await gate.landed;
      }
      return FakeRuntime.prototype.scheduleAlarm.apply(this, alarm);
    };
    await world.apply(worldAction("the agent sets the plan", () => setPlan(workflow, {})));
    return replay;
  }

  /** Take one spec action, then bring up every sandbox that waits. Returns what the step sent. */
  async take(step: Pick<TraceStep, "action" | "picks">): Promise<SpecOutput> {
    const deliveriesBefore = this.world.workflow.deliveries.length;
    const outboxBefore = this.world.lastOutboxId();
    this.world.setTrackerHealth(TRACKER_HEALTH[step.picks.health ?? "TrackerUp"]);
    await this.world.apply(this.actionFor(step));
    this.world.setTrackerHealth("up");
    await this.world.apply(
      worldAction("sandboxes come up", async (world) => {
        for (const task of world.tasksAwaitingSandbox()) await world.startSandboxOf(task.task_id);
      }),
    );
    const deliveries = this.world.workflow.deliveries.slice(deliveriesBefore);
    const rows = this.world.outboxRowsAfter(outboxBefore);
    return {
      posts: deliveries.map(({ event, targets }) => {
        const kind = POST_KIND_OF[event.type];
        if (!kind) throw new Error(`the spec has no post kind for ${event.type}`);
        return { kind, targets: targets.map(targetName).toSorted() };
      }),
      feed: byJob(
        rows
          .filter((row) => row.channel === "feed" && !NOT_FEED_ACTIVITIES.includes(row.kind))
          .map((row) => this.feedPostOf(feedPayloadOf(row.payload))),
      ),
      plans: rows
        .filter((row) => row.channel === "feed" && row.kind === "plan")
        .map((row) => issueOfKey(issueKeyOfTarget(row.target)))
        .toSorted(),
    };
  }

  /** The session messages as the spec sees them, in the order they were sent. */
  messages(): SpecMessage[] {
    const { store } = this.world.workflow;
    return this.sent.map(({ event, held }) => ({
      inFlight: held.length,
      seen: store.eventSeen(event.id),
    }));
  }

  /** The workflow as the spec sees it. */
  project(): SpecRouting {
    const { workflow } = this.world;
    const { store, state, transcript } = workflow;
    const jobs = store.jobs();
    return {
      subject: specSubjectOf(state.subject ?? null),
      replyTargets: state.reply_targets.map(targetName).toSorted(),
      jobs: jobs.map((job) => {
        const author = store.authorTask(job.job_id);
        const researcher = store.researcherTask(job.job_id);
        const sandbox = author ? store.sandbox(author.task_id) : null;
        const status = author ? this.authorStatusOf(author) : "NotStarted";
        return {
          issue: issueOfKey(job.issue_id),
          author: status,
          queued: author ? store.queue().filter((row) => row.task_id === author.task_id).length : 0,
          handedOver: Boolean(store.artifact(job.job_id)?.delivered_to_humans_at),
          buffered: Boolean(author && workflow.sessionFeeds.get(author.task_id)?.message),
          todos: todosOf(workflow, author),
          restarts: (author ?? researcher)?.restarts ?? 0,
          stoppedEarly: Boolean(sandbox?.stopped_early),
          containerClosed: status === "Idle" && Boolean(sandbox) && !sandbox?.session_id,
          paused: Boolean(author && author.paused_at !== null),
          cancelSent: Boolean(
            author &&
            !isTaskFinished(author.status) &&
            this.world.runningBridgeOf(author.task_id)?.cancelRequested,
          ),
          research: researcher ? RESEARCH_OF[researcher.status] : "NoResearch",
          researcherTodos: todosOf(workflow, researcher),
        };
      }),
      waiting: transcript
        .inbox()
        .flatMap((row) =>
          row.wake === "message" && row.reply_to ? [targetName(row.reply_to)] : [],
        )
        .filter((name, index, names) => names.indexOf(name) === index)
        .toSorted(),
      links: store
        .outbox()
        .filter((row) => row.kind === "attach_chat_thread")
        .map((row) => issueOfKey(issueKeyOfTarget(row.target))),
      boards: jobs
        .flatMap((job, index) =>
          store
            .boards(job.job_id)
            .map((board) => `${index}@${threadOfBoardKey(board.channel_key)}`),
        )
        .filter((name, index, names) => names.indexOf(name) === index)
        .toSorted(),
      waitsForInput: state.status === "waiting_input",
      ended: isWorkflowFinished(state.status),
    };
  }

  private authorStatusOf(author: TaskRow): SpecJob["author"] {
    switch (author.status) {
      case "queued":
      case "provisioning":
        return "InTurn";
      case "working":
        return this.world.workflow.store.sandbox(author.task_id)?.prompt_in_flight
          ? "InTurn"
          : "Idle";
      case "in_review":
        return "InReview";
      case "done":
      case "cancelled":
      case "failed":
        return "Finished";
      default: {
        const unreachable: never = author.status;
        throw new Error(`unhandled task status ${String(unreachable)}`);
      }
    }
  }

  private feedPostOf(payload: FeedPayload): SpecFeedPost {
    const { store } = this.world.workflow;
    const task = store.requireTask(payload.task_id);
    const job = store.jobs().findIndex((row) => row.job_id === task.job_id);
    const stored = this.world.tracker.stored.filter((activity) => activity.id === payload.id);
    return { job, kind: feedKindOf(payload.content), stored: stored.length };
  }

  private actionFor(step: Pick<TraceStep, "action" | "picks">): WorkflowAction {
    const { picks } = step;
    switch (step.action) {
      case "personWritesInSession":
        return worldAction(
          `a person says ${picks.text} in the session on ${picks.issue}`,
          (world) => this.personWritesInSession(world, required(picks.issue), required(picks.text)),
        );
      case "personSendsInSession":
        return worldAction(
          `a person sends ${picks.text} in the session on ${picks.issue}`,
          (world) => this.personSendsInSession(world, required(picks.issue), required(picks.text)),
        );
      case "trackerDeliversAgain":
        return worldAction(`the tracker delivers message ${picks.message} again`, (world) =>
          this.deliverSentMessage(world, this.sentMessage(required(picks.message))),
        );
      case "aSessionMessageLands":
        return worldAction(`a delivery of message ${picks.message} lands`, async () => {
          const delivery = this.sentMessage(required(picks.message)).held.shift();
          if (!delivery) throw new Error(`message ${picks.message} has no delivery in flight`);
          delivery.land();
          await delivery.outcome;
        });
      case "agentTurnEnds":
        return worldAction(`the agent turn ends: ${picks.outcome}`, (world) =>
          this.agentTurnEnds(world, required(picks.outcome)),
        );
      case "agentStartsJob":
        return worldAction(`the agent starts a job on ${picks.issue}`, async (world) => {
          const { start_job } = startTools(world.workflow, [REQUEST_TEXT]);
          await start_job.execute(
            { stage: STAGE, brief: "Write the design.", issue: ISSUE_KEY[required(picks.issue)] },
            TOOL_CALL,
          );
        });
      case "agentNamesTheSubject": {
        const subject = required(picks.subject);
        if (subject === "NoSubject") throw new Error("a plan cannot name no subject");
        return worldAction(`the agent's plan names the subject ${subject}`, (world) =>
          setPlan(world.workflow, { subject: SUBJECT_LINK[subject] }),
        );
      }
      case "trackerOpensSession":
        return worldAction(`the tracker opens a session on ${picks.issue}`, (world) => {
          const issue = ISSUE_KEY[required(picks.issue)];
          return world.deliver({
            kind: "start",
            text: "",
            actor: null,
            bindings: [{ source: "tracker_issue", external_id: issue }],
            reply_to: { source: "tracker", session_id: `session-${issue}`, issue_id: issue },
          });
        });
      case "chatThreadJoins":
        return chatThreadJoins();
      case "authorStreams":
        return authorStreams(
          this.unfinishedIndexOf(required(picks.id)),
          required(picks.streamed) === "Message" ? "message" : "tool",
        );
      case "authorReportsTodos":
        return authorReportsTodos(
          this.unfinishedIndexOf(required(picks.id)),
          required(picks.todos),
        );
      case "authorRecordsArtifact":
        return firstArtifactAppears(this.unfinishedIndexOf(required(picks.id)), "author_text");
      case "authorTurnEnds":
        return worldAction(
          `the turn of the author of job ${picks.id} ends: ${picks.turnEnding}`,
          (world) => this.authorTurnEnds(world, required(picks.id), required(picks.turnEnding)),
        );
      case "authorFails":
        return worldAction(`the author of job ${picks.id} passes the wall clock`, (world) =>
          this.wallClockFires(world, required(picks.id)),
        );
      case "personStops":
        return worldAction(`a person presses Stop in the session on ${picks.issue}`, (world) =>
          world.deliver(stopEvent(this.sessionOn(world, required(picks.issue)))),
        );
      case "personStopsAModelCall":
        return worldAction(
          `a person presses Stop while the model call of the author of job ${picks.id} is out`,
          (world) => this.personStopsAModelCall(world, required(picks.id)),
        );
      case "workflowRestarts":
        return worldAction("the workflow restarts", async (world) => {
          for (const message of this.sent) message.held = [];
          await world.restart();
        });
      case "researcherReportsTodos":
        return researcherReportsTodos(
          this.researcherIndexOf(required(picks.id)),
          required(picks.todos),
        );
      case "researcherHandsOver":
        return worldAction(`the researcher of job ${picks.id} hands over`, (world) =>
          this.researcherHandsOver(world, required(picks.id)),
        );
      case "researcherLeavesNoPayload":
        return researcherTurnEnds(this.researcherIndexOf(required(picks.id)), "missing");
      case "agentPausesAuthor":
        return agentHoldsAuthor(this.unfinishedIndexOf(required(picks.id)), "pause_task");
      case "agentResumesAuthor":
        return agentHoldsAuthor(this.unfinishedIndexOf(required(picks.id)), "resume_task");
      case "idleClockFires":
        return worldAction("the idle clock fires", async (world) => {
          const { workflow } = world;
          if (workflow.state.idle_alarm) await workflow.cancelAlarm(workflow.state.idle_alarm);
          await onIdle(workflow);
        });
      case "boardFlushes":
        return worldAction(`the board of job ${picks.id} flushes`, (world) =>
          flushBoards(world.workflow, this.jobIdOf(required(picks.id))),
        );
      case "agentEndsWorkflow":
        return worldAction(`the agent ends the workflow: ${picks.ending}`, (world) =>
          this.endWorkflow(world, required(picks.ending)),
        );
      default:
        throw new Error(`no world action for spec action ${step.action}`);
    }
  }

  private sessionOn(
    world: WorkflowWorld,
    issue: Issue,
  ): Extract<ReplyTarget, { source: "tracker" }> {
    const session = world.workflow.state.reply_targets.find(
      (target): target is Extract<ReplyTarget, { source: "tracker" }> =>
        target.source === "tracker" && target.issue_id === ISSUE_KEY[issue],
    );
    if (!session) throw new Error(`the workflow has no session on ${issue}`);
    return session;
  }

  private async personWritesInSession(
    world: WorkflowWorld,
    issue: Issue,
    said: SessionText,
  ): Promise<void> {
    await world.deliver(this.sessionEvent(world, issue, said));
  }

  private async personSendsInSession(
    world: WorkflowWorld,
    issue: Issue,
    said: SessionText,
  ): Promise<void> {
    const message: SentMessage = {
      event: {
        id: `session-message-${this.sent.length}`,
        ...this.sessionEvent(world, issue, said),
      },
      held: [],
    };
    this.sent.push(message);
    await this.deliverSentMessage(world, message);
  }

  /** Start a delivery of a sent message. It waits on the idle clock when it reaches it. */
  private async deliverSentMessage(world: WorkflowWorld, message: SentMessage): Promise<void> {
    const atTheIdleClock = new Deferred<"held">();
    const landing = new Deferred<void>();
    this.gates.next = { arrived: () => atTheIdleClock.resolve("held"), landed: landing.promise };
    const outcome = world.startDelivery(message.event);
    const settled = await Promise.race([atTheIdleClock.promise, outcome]);
    this.gates.next = null;
    if (settled === "held") message.held.push({ land: landing.resolve, outcome });
  }

  private sentMessage(index: number): SentMessage {
    const message = this.sent[index];
    if (!message) throw new Error(`no session message ${index} was sent`);
    return message;
  }

  private sessionEvent(
    world: WorkflowWorld,
    issue: Issue,
    said: SessionText,
  ): Omit<SentMessage["event"], "id"> {
    const session = this.sessionOn(world, issue);
    return {
      ...SESSION_EVENTS[said],
      reply_to: session,
      bindings: [
        { source: "tracker_issue", external_id: session.issue_id },
        { source: "tracker_session", external_id: session.session_id },
      ],
    };
  }

  private async agentTurnEnds(world: WorkflowWorld, outcome: Outcome): Promise<void> {
    const { workflow } = world;
    workflow.transcript.takeInbox();
    switch (outcome) {
      case "Answers":
        await channelTools(workflow, workflow.transcript.answering()).tell.execute(
          { text: "The redirect skips the check on a stale session." },
          TOOL_CALL,
        );
        workflow.transcript.deleteTaken();
        return;
      case "Asks":
        await channelTools(workflow, workflow.transcript.answering()).ask.execute(
          { text: "Should the redirect keep the query string?" },
          TOOL_CALL,
        );
        workflow.transcript.deleteTaken();
        return;
      case "TimesOut": {
        const startedAt = await armTurnWatchdog(workflow);
        await onTurnTimeout(workflow, { started_at: startedAt });
        return;
      }
      default: {
        const unreachable: never = outcome;
        throw new Error(`unhandled outcome ${String(unreachable)}`);
      }
    }
  }

  private async authorTurnEnds(
    world: WorkflowWorld,
    jobIndex: number,
    ending: TurnEnding,
  ): Promise<void> {
    const index = this.unfinishedIndexOf(jobIndex);
    if (ending === "PromptFails") {
      await authorPromptFails(index, "same").run(world);
      return;
    }
    await authorTurnEnds(index, "same", CLOSING_OF[ending]).run(world);
  }

  private async personStopsAModelCall(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const facts = await personStopsModelCall(this.unfinishedIndexOf(jobIndex), "agent_prompts").run(
      world,
    );
    if (!facts?.modelCallStopped) {
      throw new Error(`the stop did not land while the model call of job ${jobIndex} was out`);
    }
  }

  private async researcherHandsOver(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const researcher = this.world.workflow.store.researcherTask(this.jobIdOf(jobIndex));
    const bridge = researcher ? world.runningBridgeOf(researcher.task_id) : null;
    if (!bridge) throw new Error(`the researcher of job ${jobIndex} has no running turn`);
    await bridge.say(`I opened ${pageUrl(1)} for this.`);
    await researcherTurnEnds(this.researcherIndexOf(jobIndex), "written").run(world);
  }

  private async wallClockFires(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const { task_id } = this.authorOf(this.jobIdOf(jobIndex));
    const alarm = world.workflow
      .alarmsFor("onWallClock")
      .find((armed) => taskIdOfAlarm(armed.payload) === task_id);
    if (!alarm) throw new Error(`the author of job ${jobIndex} has no wall clock armed`);
    await world.workflow.cancelAlarm(alarm.id);
    await onWallClock(world.workflow, { task_id });
  }

  private async endWorkflow(world: WorkflowWorld, ending: Ending): Promise<void> {
    const tools = planTools(world.workflow);
    if (ending === "Finishes") {
      await tools.finish_workflow.execute({ result: "The design is written." }, TOOL_CALL);
      return;
    }
    await tools.fail_workflow.execute({ reason: "The repository cannot be built." }, TOOL_CALL);
  }

  private jobIdOf(jobIndex: number): string {
    const job = this.world.workflow.store.jobs()[jobIndex];
    if (!job) throw new Error(`the world has no job ${jobIndex}`);
    return job.job_id;
  }

  private authorOf(jobId: string): TaskRow {
    const author = this.world.workflow.store.authorTask(jobId);
    if (!author) throw new Error(`job ${jobId} has no author`);
    return author;
  }

  /** The index `authorAt` counts the author of the job by, among the unfinished authors. */
  private unfinishedIndexOf(jobIndex: number): number {
    const taskId = this.authorOf(this.jobIdOf(jobIndex)).task_id;
    return this.world.authors
      .filter((author) => !isTaskFinished(this.world.taskOf(author).status))
      .findIndex((author) => author.taskId === taskId);
  }

  /** The index `researcherAt` counts the researcher of the job by, among the unfinished ones. */
  private researcherIndexOf(jobIndex: number): number {
    const researcher = this.world.workflow.store.researcherTask(this.jobIdOf(jobIndex));
    if (!researcher) throw new Error(`job ${jobIndex} has no researcher`);
    return this.world.workflow.store
      .tasks()
      .filter((task) => task.role === "researcher" && !isTaskFinished(task.status))
      .findIndex((task) => task.task_id === researcher.task_id);
  }
}

/** The agent sets the plan of the one stage, and names `subject` when given. */
async function setPlan(workflow: WorkflowRuntime, named: { subject?: string }): Promise<void> {
  await planTools(workflow).set_plan.execute(
    {
      name: "Fix login",
      definition: workflow.workflowDefinitions()[0]?.name ?? "",
      reason: "the request asks for a design",
      stages: [STAGE],
      repo: REPO,
      page_parent: workflow.state.page_parent,
      concurrency: ISSUES.length,
      ...named,
    },
    TOOL_CALL,
  );
}

function specSubjectOf(subject: Subject | null): SpecSubject {
  if (!subject) return "NoSubject";
  if (subject.kind === "project") return "ProjectSubject";
  if (issueOfKey(subject.issue_id) !== "SubjectIssue") {
    throw new Error(`the spec has no subject issue ${subject.issue_id}`);
  }
  return "IssueSubject";
}

function taskIdOfAlarm(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("task_id" in payload)) return null;
  return typeof payload.task_id === "string" ? payload.task_id : null;
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the spec action is missing a pick");
  return value;
}
