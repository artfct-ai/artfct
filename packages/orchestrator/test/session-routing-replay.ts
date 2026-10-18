import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import { channelTools } from "../src/agent/tools/channel";
import { planTools } from "../src/agent/tools/plan";
import { startTools } from "../src/agent/tools/start/start";
import { armTurnWatchdog, onTurnTimeout } from "../src/agent/turn/watchdog";
import { flushBoards } from "../src/workflow/board/board";
import { isTaskFinished, isWorkflowFinished } from "../src/workflow/store/state";
import type { TaskRow } from "../src/workflow/store/tasks";
import { onWallClock } from "../src/workflow/task/harness/timers";
import type { TaskEvent } from "../src/workflow/task/events";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import { authorTurnEnds, chatThreadJoins, firstArtifactAppears } from "./workflow-actions";
import {
  REPO,
  STAGE_OF,
  WorkflowWorld,
  type WorkflowAction,
  type WorldSetup,
} from "./workflow-world";
import { SUBJECT_ISSUE_KEY, subIssueKey, worldIssueUrl } from "./world-tracker";

/** The setup modules of the session routing spec, and where each workflow starts. */
export const SPEC_SETUPS = {
  chatThread: { origin: "chat" },
  trackerOnly: { origin: "tracker" },
} as const satisfies Record<string, Pick<WorldSetup, "origin">>;

/** The name of one setup module of the spec. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

const TRACE_STEPS = 25;

const ISSUES = ["SubjectIssue", "SubIssue"] as const;
const AUTHOR_STATUSES = ["Running", "InReview", "Finished"] as const;
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
const SESSION_TEXTS = ["Question", "StatusRequest"] as const;
const OUTCOMES = ["Answers", "Asks", "TimesOut"] as const;
const ENDINGS = ["Finishes", "Fails"] as const;

type Issue = (typeof ISSUES)[number];
type PostKind = (typeof POST_KINDS)[number];
type SessionText = (typeof SESSION_TEXTS)[number];
type Outcome = (typeof OUTCOMES)[number];
type Ending = (typeof ENDINGS)[number];

/** The tracker issue key of each issue of the spec. */
const ISSUE_KEY: Record<Issue, string> = {
  SubjectIssue: SUBJECT_ISSUE_KEY,
  SubIssue: subIssueKey(0),
};

/** The chat channel of each chat thread of the spec, by number. */
const CHAT_CHANNELS = ["C1", "C2"];

/** One job as the spec sees it. */
type SpecJob = {
  issue: Issue;
  author: (typeof AUTHOR_STATUSES)[number];
  queued: number;
  handedOver: boolean;
};

/** One post and the reply targets it reached, each target by its spec name. */
export type SpecPost = { kind: PostKind; targets: string[] };

/** The workflow as the spec sees it. Targets go by their spec names, and sets are sorted. */
export type SpecRouting = {
  replyTargets: string[];
  jobs: SpecJob[];
  waiting: string[];
  links: Issue[];
  boards: string[];
  ended: boolean;
};

/** The values the spec picked for one action. */
type SpecPicks = {
  issue: Issue | null;
  text: SessionText | null;
  outcome: Outcome | null;
  job: number | null;
  ending: Ending | null;
};

/** One state of a trace: the action that led to it, its picks, the posts of its step, and the workflow. */
export type TraceStep = {
  action: string;
  picks: SpecPicks;
  posts: SpecPost[];
  routing: SpecRouting;
};

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  const traces = await quintTraces({
    spec: "session-routing",
    setup,
    count,
    steps: TRACE_STEPS,
    seed,
  });
  return traces.map((trace) => traceSteps(setup, trace));
}

/** The steps of one spec trace, given as its ITF JSON, run on one setup. */
export function traceSteps(setup: SpecSetup, trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const picks = itfField(state, "mbt::nondetPicks");
    const picked = (name: string, names: readonly string[]) => {
      const pick = itfVariant(itfField(picks, name, true));
      if (pick?.tag !== "Some") return null;
      return itfOneOf(itfVariant(pick.value)!.tag, names);
    };
    const job = itfVariant(itfField(picks, "job", true));
    const facts = itfField(state, `${setup}::sessionRouting::lastStep`);
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        issue: picked("issue", ISSUES) as Issue | null,
        text: picked("text", SESSION_TEXTS) as SessionText | null,
        outcome: picked("outcome", OUTCOMES) as Outcome | null,
        job: job?.tag === "Some" ? itfInt(job.value) : null,
        ending: picked("ending", ENDINGS) as Ending | null,
      },
      posts: itfList(itfField(facts, "posts")).map((post) => ({
        kind: itfOneOf(itfVariant(itfField(post, "kind"))!.tag, POST_KINDS),
        targets: itfSet(itfField(post, "targets")).map(specTargetName).toSorted(),
      })),
      routing: specRouting(itfField(state, `${setup}::sessionRouting::routing`)),
    };
  });
}

function specTargetName(value: unknown): string {
  const target = itfVariant(value)!;
  if (target.tag === "ChatThread") return `ChatThread(${itfInt(target.value)})`;
  return `Session(${itfOneOf(itfVariant(target.value)!.tag, ISSUES)})`;
}

function specRouting(value: unknown): SpecRouting {
  return {
    replyTargets: itfSet(itfField(value, "replyTargets")).map(specTargetName).toSorted(),
    jobs: itfList(itfField(value, "jobs")).map((job) => ({
      issue: itfOneOf(itfVariant(itfField(job, "issue"))!.tag, ISSUES),
      author: itfOneOf(itfVariant(itfField(job, "author"))!.tag, AUTHOR_STATUSES),
      queued: itfInt(itfField(job, "queued")),
      handedOver: itfBool(itfField(job, "handedOver")),
    })),
    waiting: itfSet(itfField(value, "waiting")).map(specTargetName).toSorted(),
    links: itfList(itfField(value, "links")).map((issue) =>
      itfOneOf(itfVariant(issue)!.tag, ISSUES),
    ),
    boards: itfSet(itfField(value, "boards"))
      .map((board) => `${itfInt(itfField(board, "job"))}@${itfInt(itfField(board, "thread"))}`)
      .toSorted(),
    ended: itfBool(itfField(value, "ended")),
  };
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const REQUEST_TEXT = "Fix the login redirect.";
const STAGE = STAGE_OF.page;

const WORLD_SETUP: Omit<WorldSetup, "origin"> = {
  opening: "request",
  artifact: "page",
  refiners: "none",
  research: false,
  pageAuthor: "harness",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  firstInput: "request",
  subject: "none",
  sandboxStart: "at_task_start",
};

/** What a person types in a tracker session for each session text of the spec. */
const SESSION_EVENTS: Record<SessionText, { kind: "prompt" | "status"; text: string }> = {
  Question: { kind: "prompt", text: "Why does the redirect skip the check?" },
  StatusRequest: { kind: "status", text: "status?" },
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

const AUTHOR_STATUS_OF: Record<TaskStatus, SpecJob["author"]> = {
  queued: "Running",
  provisioning: "Running",
  working: "Running",
  in_review: "InReview",
  done: "Finished",
  cancelled: "Finished",
  failed: "Finished",
};

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

function issueKeyOfLink(target: unknown): string | null {
  if (typeof target !== "object" || target === null || !("issue_id" in target)) return null;
  return typeof target.issue_id === "string" ? target.issue_id : null;
}

/**
 * Replays session routing traces through a workflow world that starts in a chat thread or in a
 * tracker session. Each spec action maps to the entry point production uses. The agent turn
 * runs as its tools and its watchdog would: it takes the inbox, posts, and deletes what it took.
 */
export class SessionRoutingReplay {
  private postsBefore = 0;

  private constructor(readonly world: WorkflowWorld) {}

  /** A started world of `setup`. A chat workflow's plan names the subject issue. */
  static async open(setup: SpecSetup): Promise<SessionRoutingReplay> {
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, ...SPEC_SETUPS[setup] });
    const { workflow } = world;
    const recordNote = workflow.tellAgent.bind(workflow);
    workflow.tellAgent = async (text, wake, from) => {
      workflow.transcript.enqueue(text, wake, from);
      await recordNote(text, wake, from);
    };
    const replay = new SessionRoutingReplay(world);
    const chat = SPEC_SETUPS[setup].origin === "chat";
    await world.apply(
      worldAction("the agent sets the plan", async () => {
        await planTools(workflow).set_plan.execute(
          {
            name: "Fix login",
            definition: workflow.workflowDefinitions()[0]?.name ?? "",
            reason: "the request asks for a design",
            stages: [STAGE],
            repo: REPO,
            page_parent: null,
            concurrency: ISSUES.length,
            ...(chat ? { subject: worldIssueUrl(SUBJECT_ISSUE_KEY) } : {}),
          },
          TOOL_CALL,
        );
      }),
    );
    replay.postsBefore = workflow.deliveries.length;
    return replay;
  }

  /** Take one spec action, then bring up every sandbox that waits. Returns the posts it made. */
  async take(step: TraceStep): Promise<SpecPost[]> {
    this.postsBefore = this.world.workflow.deliveries.length;
    await this.world.apply(this.actionFor(step));
    await this.world.apply(
      worldAction("sandboxes come up", async (world) => {
        for (const task of world.tasksAwaitingSandbox()) await world.startSandboxOf(task.task_id);
      }),
    );
    return this.posts();
  }

  /** The posts since the last action, as the spec sees them. */
  posts(): SpecPost[] {
    return this.world.workflow.deliveries.slice(this.postsBefore).map(({ event, targets }) => {
      const kind = POST_KIND_OF[event.type];
      if (!kind) throw new Error(`the spec has no post kind for ${event.type}`);
      return { kind, targets: targets.map(targetName).toSorted() };
    });
  }

  /** The workflow as the spec sees it. */
  project(): SpecRouting {
    const { store, state, transcript } = this.world.workflow;
    const jobs = store.jobs();
    return {
      replyTargets: state.reply_targets.map(targetName).toSorted(),
      jobs: jobs.map((job) => {
        const author = this.authorOf(job.job_id);
        return {
          issue: issueOfKey(job.issue_id),
          author: AUTHOR_STATUS_OF[author.status],
          queued: store.queue().filter((row) => row.task_id === author.task_id).length,
          handedOver: this.world.workflow.posted.some(
            (event) => event.type === "artifact_ready" && event.job_id === job.job_id,
          ),
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
        .map((row) => issueOfKey(issueKeyOfLink(row.target))),
      boards: jobs
        .flatMap((job, index) =>
          store
            .boards(job.job_id)
            .map((board) => `${index}@${threadOfBoardKey(board.channel_key)}`),
        )
        .filter((name, index, names) => names.indexOf(name) === index)
        .toSorted(),
      ended: isWorkflowFinished(state.status),
    };
  }

  private actionFor(step: TraceStep): WorkflowAction {
    const { picks } = step;
    switch (step.action) {
      case "personWritesInSession":
        return worldAction(
          `a person says ${picks.text} in the session on ${picks.issue}`,
          (world) => this.personWritesInSession(world, required(picks.issue), required(picks.text)),
        );
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
      case "authorHandsOver":
        return worldAction(`the author of job ${picks.job} hands over`, async (world) => {
          const index = this.unfinishedIndexOf(required(picks.job));
          await firstArtifactAppears(index, "author_text").run(world);
          await authorTurnEnds(index, "same", "finished").run(world);
        });
      case "authorFails":
        return worldAction(`the author of job ${picks.job} passes the wall clock`, (world) =>
          this.wallClockFires(world, required(picks.job)),
        );
      case "boardFlushes":
        return worldAction(`the board of job ${picks.job} flushes`, (world) =>
          flushBoards(world.workflow, this.jobIdOf(required(picks.job))),
        );
      case "agentEndsWorkflow":
        return worldAction(`the agent ends the workflow: ${picks.ending}`, (world) =>
          this.endWorkflow(world, required(picks.ending)),
        );
      default:
        throw new Error(`no world action for spec action ${step.action}`);
    }
  }

  private async personWritesInSession(
    world: WorkflowWorld,
    issue: Issue,
    said: SessionText,
  ): Promise<void> {
    const session = world.workflow.state.reply_targets.find(
      (target): target is Extract<ReplyTarget, { source: "tracker" }> =>
        target.source === "tracker" && target.issue_id === ISSUE_KEY[issue],
    );
    if (!session) throw new Error(`the workflow has no session on ${issue}`);
    await world.deliver({
      ...SESSION_EVENTS[said],
      reply_to: session,
      bindings: [
        { source: "tracker_issue", external_id: session.issue_id },
        { source: "tracker_session", external_id: session.session_id },
      ],
    });
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
    const author = this.world.workflow.store
      .tasks()
      .findLast((task) => task.job_id === jobId && task.role === "author");
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
}

function taskIdOfAlarm(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("task_id" in payload)) return null;
  return typeof payload.task_id === "string" ? payload.task_id : null;
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the spec action is missing a pick");
  return value;
}
