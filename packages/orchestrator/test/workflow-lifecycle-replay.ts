import { setSystemTime } from "bun:test";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import type { TaskStatus, WorkflowStatus } from "@artfct-ai/contracts/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { planTools } from "../src/agent/tools/plan";
import {
  ASK_WHETHER_ACCEPTED,
  ASK_WHICH_OPTION,
  jobDoneText,
  startTools,
  TELL_THE_CHECK_IS_UNAVAILABLE,
} from "../src/agent/tools/start/start";
import { labeledPageCommentIds } from "../src/artifact/page-comment-label";
import { CLOSING_TEXT_MARKER, replyMarker } from "../src/prompts/model-author-prompt";
import { taskTools } from "../src/agent/tools/task";
import type { SandboxRef } from "../src/sandbox/spec";
import { artifactRefKey, jobInputKey } from "../src/workflow/store/input-key";
import type { ArtifactRow } from "../src/workflow/store/records";
import { failTask } from "../src/workflow/lifecycle";
import { isTaskFinished, type Subject } from "../src/workflow/store/state";
import type { JobRow, TaskRow } from "../src/workflow/store/tasks";
import type { ConnectionState } from "../src/workflow/task/harness/bridge";
import { onNoProgress } from "../src/workflow/task/harness/timers";
import { onModelTurnDeadline, type ModelTurnAlarm } from "../src/workflow/task/model-turn";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { strayIssueKey, SUBJECT_ISSUE_KEY, subIssueKey } from "./world-tracker";
import { quintTraces } from "./quint-traces";
import { toolText } from "./tool-result";
import { EchoModel } from "./fake-model";
import { FakeRuntime, fakeDocumentsOf, MODEL_AUTHOR_MODEL, PAGE_PARENT } from "./fake-runtime";
import { FakeSandboxProvider } from "./fake-sandbox";
import { InterleavedDecisions } from "./interleaved-decisions";
import {
  authorTurnEnds,
  firstArtifactAppears,
  GENERATION_TIMERS,
  personCancels,
  endRefinerRunTurn,
  personPressesStop,
  personWrites,
  researcherTurnEnds,
  type RefinerRunEnd,
  staleAlarmFires,
  timerFires,
  workflowRestarts,
} from "./workflow-actions";
import {
  PAGE_OPTION,
  REPO,
  REQUEST_TEXTS,
  SECOND_DEFINITION,
  STAGE_OF,
  WorkflowWorld,
  type Step,
  type StepFacts,
  type TrackerLink,
  type WorkflowAction,
  type WorldAuthor,
  type WorldSetup,
} from "./workflow-world";

/**
 * The setups the replay runs, each on the traces of one setup module of the workflow lifecycle
 * spec, and the stage each one runs. A judge runs on the traces of the reviewer.
 */
export const SPEC_SETUPS = {
  pagesWithAReviewer: {
    module: "pagesWithAReviewer",
    refiners: "reviewer",
    pageAuthor: "harness",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  pagesWithAJudge: {
    module: "pagesWithAReviewer",
    refiners: "judge",
    pageAuthor: "harness",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  pagesWithAPolisher: {
    module: "pagesWithAPolisher",
    refiners: "polisher",
    pageAuthor: "harness",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  pagesWithoutRefiners: {
    module: "pagesWithoutRefiners",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  pagesWithAChoice: {
    module: "pagesWithAChoice",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "choice",
  },
  issuesForAChatRequest: {
    module: "issuesForAChatRequest",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "issues",
    origin: "chat",
    pageEnding: "acceptance",
  },
  pagesAfterResearch: {
    module: "pagesAfterResearch",
    refiners: "none",
    pageAuthor: "harness",
    research: true,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  pagesFromModelCalls: {
    module: "pagesFromModelCalls",
    refiners: "none",
    pageAuthor: "model",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  modelCallPagesWithAReviewer: {
    module: "modelCallPagesWithAReviewer",
    refiners: "reviewer",
    pageAuthor: "model",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  modelCallPagesWithAJudge: {
    module: "modelCallPagesWithAReviewer",
    refiners: "judge",
    pageAuthor: "model",
    research: false,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  modelCallPagesAfterResearch: {
    module: "modelCallPagesAfterResearch",
    refiners: "none",
    pageAuthor: "model",
    research: true,
    artifact: "page",
    origin: "chat",
    pageEnding: "acceptance",
  },
  modelCallPagesForAnIssue: {
    module: "modelCallPagesForAnIssue",
    refiners: "none",
    pageAuthor: "model",
    research: false,
    artifact: "page",
    origin: "tracker",
    pageEnding: "acceptance",
  },
  pullsTheHostMoves: {
    module: "pullsTheHostMoves",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "pull",
    origin: "tracker",
    pageEnding: "acceptance",
  },
  pullsForAnEndedSubject: {
    module: "pullsForAnEndedSubject",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "pull",
    origin: "tracker",
    pageEnding: "acceptance",
  },
  pullsForAnEndedSubIssue: {
    module: "pullsForAnEndedSubIssue",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "pull",
    origin: "tracker",
    pageEnding: "acceptance",
  },
  pullsForTwoIssues: {
    module: "pullsForTwoIssues",
    refiners: "none",
    pageAuthor: "harness",
    research: false,
    artifact: "pull",
    origin: "tracker",
    pageEnding: "acceptance",
  },
} as const satisfies Record<
  string,
  { module: string } & Pick<
    WorldSetup,
    "refiners" | "pageAuthor" | "research" | "artifact" | "origin" | "pageEnding"
  >
>;

/** The name of one setup the replay runs. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

const STEP_MS = 10 * 60_000;
const REPLAY_START = Date.parse("2026-01-01T00:00:00.000Z");

const TASK_STATUSES = ["Busy", "InReview", "TaskDone", "TaskCancelled", "TaskFailed"] as const;
const WORKFLOW_STATUSES = [
  "New",
  "Running",
  "WaitingInput",
  "Done",
  "Failed",
  "Cancelled",
] as const;
const ARTIFACT_STATUSES = ["NoArtifact", "Drafted", "Ready", "Accepted", "Removed"] as const;
const PULLS_ON_HOST = ["NoPull", "PullOpen", "PullMerged", "PullClosed"] as const;
const HOST_MOVES = ["Merged", "ClosedUnmerged", "Reopened"] as const;
const REFINER_RUN_STATUSES = [
  "RefinerRunning",
  "RefinerDone",
  "RefinerCancelled",
  "RefinerFailed",
] as const;
const CALL_KINDS = ["SandboxDestroy", "AcceptanceCheck", "ModelCall", "PageWrite"] as const;
const CHECK_ANSWERS = ["CheckPasses", "CheckDoesNotPass", "CheckUnavailable"] as const;
const COMPLETION_ANSWERS = [
  "NotAnswered",
  "Completes",
  "AsksAgain",
  "SaysUnavailable",
  "Refuses",
] as const;
const ROLES = ["Researcher", "Author"] as const;
const JOB_ROLES: readonly TaskRow["role"][] = ["researcher", "author"];
const ENDINGS = ["PersonCancels", "AgentFails", "AgentFinishes"] as const;
const VERBAL_COMMANDS = ["Pause", "Resume", "Instruct"] as const;

/** The chat message a person writes for each verbal command of the spec. */
const VERBAL_COMMAND_TEXT = {
  Pause: "pause",
  Resume: "resume",
  Instruct: "instruct Use the session cookie.",
} as const satisfies Record<(typeof VERBAL_COMMANDS)[number], string>;

/** The world timer of each generation timer of the spec. */
const GENERATION_TIMER_OF = {
  HelloTimeout: "hello_timeout",
  NoProgress: "no_progress",
  KeepAlive: "keep_alive",
  BridgeLost: "bridge_lost",
  QueueRetry: "queue_retry",
  SettleIdleAuthor: "settle_idle_author",
} as const satisfies Record<string, (typeof GENERATION_TIMERS)[number]>;
const SPEC_TIMERS = Object.keys(GENERATION_TIMER_OF) as (keyof typeof GENERATION_TIMER_OF)[];

/** The workflow definition the spec names by 2, which the deployment does not hold. */
const UNDECLARED_DEFINITION = "triage";

type CallKind = (typeof CALL_KINDS)[number];
type CheckAnswer = (typeof CHECK_ANSWERS)[number];

/** What `complete_job` told the agent in one step, as the spec names it. */
export type CompletionAnswer = (typeof COMPLETION_ANSWERS)[number];
type Ending = (typeof ENDINGS)[number];
type VerbalCommand = (typeof VERBAL_COMMANDS)[number];
type GenerationTimer = (typeof GENERATION_TIMERS)[number];
type HostMove = (typeof HOST_MOVES)[number];

/**
 * The tracker issue the spec names by each number: the subject issue, a sub-issue of it, and an
 * issue outside the subject issue and the project.
 */
const ISSUE_KEYS = [SUBJECT_ISSUE_KEY, subIssueKey(0), strayIssueKey(0)] as const;

/** The state the tracker shows for an issue a person ended. */
const CANCELED_STATE = { type: "canceled", name: "Canceled" } as const;

/** A researcher or author task of one job as the spec sees it. */
type SpecTask = {
  role: (typeof ROLES)[number];
  startOrder: number;
  status: (typeof TASK_STATUSES)[number];
  restarts: number;
  paused: boolean;
  turnRunning: boolean;
  promptsSent: number;
  promptsQueued: number;
  generationClosed: boolean;
};

/** One job as the spec sees it. */
export type SpecJob = {
  input:
    | { from: "request"; request: number }
    | { from: "artifact"; job: number }
    | { from: "issue"; issue: number };
  tasks: SpecTask[];
  artifact: (typeof ARTIFACT_STATUSES)[number];
  refinerRuns: (typeof REFINER_RUN_STATUSES)[number][];
  pullOnHost: (typeof PULLS_ON_HOST)[number];
};

/** The subject of the workflow as the spec sees it. An issue is its number in `ISSUE_KEYS`. */
type SpecSubject = { kind: "none" } | { kind: "issue"; issue: number } | { kind: "project" };

/** One held call as the spec sees it, without the rest of the step that runs when it returns. */
type SpecCall = { kind: CallKind; job: number };

/** The workflow as the spec sees it. `jobSlots` is null until a plan sets the stages. */
export type SpecWorkflow = {
  status: (typeof WORKFLOW_STATUSES)[number];
  definition: number | null;
  jobSlots: number | null;
  subject: SpecSubject;
  idleArmed: boolean;
  jobs: SpecJob[];
  calls: SpecCall[];
  failuresPosted: number;
  issueMoves: number;
  endedIssues: number[];
};

/** The values the spec picked for one action. */
type SpecPicks = {
  definition: number | null;
  withStages: boolean | null;
  jobSlots: number | null;
  timer: GenerationTimer | null;
  sandbox: number | null;
  request: number | null;
  id: number | null;
  callId: number | null;
  checkAnswer: CheckAnswer | null;
  ending: Ending | null;
  command: VerbalCommand | null;
  landed: boolean | null;
  issue: number | null;
  hostMove: HostMove | null;
  subjectLink: SpecSubject | null;
  outputLink: SpecSubject | null;
};

/**
 * One state of a trace: the action that led to it, its picks, the workflow, whether the step told
 * the agent, and what `complete_job` answered in it.
 */
export type TraceStep = {
  action: string;
  picks: SpecPicks;
  workflow: SpecWorkflow;
  toldTheAgent: boolean;
  answered: CompletionAnswer;
};

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces(
    {
      spec: "workflow-lifecycle",
      setup: SPEC_SETUPS[setup].module,
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
    const picked = (name: string) => {
      const pick = itfVariant(itfField(picks, name, true));
      return pick?.tag === "Some" ? pick.value : null;
    };
    const ending = picked("ending");
    const command = picked("command");
    const checkAnswer = picked("answer");
    const withStages = picked("withStages");
    const timer = picked("timer");
    const landed = picked("landed");
    const hostMove = picked("hostMove");
    const subjectLink = picked("subjectLink");
    const outputLink = picked("outputLink");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        definition: optionalInt(picked("definition")),
        withStages: withStages === null ? null : itfBool(withStages),
        jobSlots: optionalInt(picked("jobSlots")),
        timer:
          timer === null
            ? null
            : GENERATION_TIMER_OF[itfOneOf(itfVariant(timer)!.tag, SPEC_TIMERS)],
        sandbox: optionalInt(picked("sandbox")),
        request: optionalInt(picked("request")),
        id: optionalInt(picked("id")),
        callId: optionalInt(picked("callId")),
        checkAnswer:
          checkAnswer === null ? null : itfOneOf(itfVariant(checkAnswer)!.tag, CHECK_ANSWERS),
        ending: ending === null ? null : itfOneOf(itfVariant(ending)!.tag, ENDINGS),
        command: command === null ? null : itfOneOf(itfVariant(command)!.tag, VERBAL_COMMANDS),
        landed: landed === null ? null : itfBool(landed),
        issue: optionalInt(picked("issue")),
        hostMove: hostMove === null ? null : itfOneOf(itfVariant(hostMove)!.tag, HOST_MOVES),
        subjectLink: subjectLink === null ? null : specSubject(subjectLink),
        outputLink: outputLink === null ? null : specSubject(outputLink),
      },
      workflow: specWorkflow(
        itfField(state, `${SPEC_SETUPS[setup].module}::workflowLifecycle::workflow`),
      ),
      toldTheAgent: itfBool(
        itfField(state, `${SPEC_SETUPS[setup].module}::workflowLifecycle::lastStepToldTheAgent`),
      ),
      answered: itfOneOf(
        itfVariant(
          itfField(state, `${SPEC_SETUPS[setup].module}::workflowLifecycle::lastStepAnswered`),
        )!.tag,
        COMPLETION_ANSWERS,
      ),
    };
  });
}

function optionalInt(value: unknown): number | null {
  return value === null ? null : itfInt(value);
}

function specWorkflow(value: unknown): SpecWorkflow {
  const definition = itfVariant(itfField(value, "definition"))!;
  const stagePlan = itfVariant(itfField(value, "stagePlan"))!;
  return {
    status: itfOneOf(itfVariant(itfField(value, "status"))!.tag, WORKFLOW_STATUSES),
    definition: definition.tag === "Planned" ? itfInt(definition.value) : null,
    jobSlots: stagePlan.tag === "StagesPlanned" ? itfInt(stagePlan.value) : null,
    subject: specSubject(itfField(value, "subject")),
    idleArmed: itfBool(itfField(value, "idleArmed")),
    jobs: itfList(itfField(value, "jobs")).map(specJob),
    calls: itfList(itfField(value, "calls")).map((call) => ({
      kind: itfOneOf(itfVariant(itfField(call, "kind"))!.tag, CALL_KINDS),
      job: itfInt(itfField(call, "job")),
    })),
    failuresPosted: itfInt(itfField(value, "failuresPosted")),
    issueMoves: itfInt(itfField(value, "issueMoves")),
    endedIssues: itfSet(itfField(value, "endedIssues"))
      .map(itfInt)
      .toSorted((left, right) => left - right),
  };
}

function specSubject(value: unknown): SpecSubject {
  const subject = itfVariant(value)!;
  switch (subject.tag) {
    case "NoSubject":
      return { kind: "none" };
    case "SubjectIssue":
      return { kind: "issue", issue: itfInt(subject.value) };
    case "SubjectProject":
      return { kind: "project" };
    default:
      throw new Error(`unknown spec subject ${subject.tag}`);
  }
}

/** The tracker link a plan or an issues output names for a spec subject. Null when it is not set. */
function trackerLinkOf(subject: SpecSubject): TrackerLink | null {
  switch (subject.kind) {
    case "none":
      return null;
    case "project":
      return "a_project";
    case "issue":
      if (ISSUE_KEYS[subject.issue] !== SUBJECT_ISSUE_KEY) {
        throw new Error(`the spec links issue ${subject.issue}, which has no tracker link`);
      }
      return "the_subject_issue";
    default: {
      const unreachable: never = subject;
      throw new Error(`unhandled spec subject ${String(unreachable)}`);
    }
  }
}

function specInput(value: unknown): SpecJob["input"] {
  const input = itfVariant(value)!;
  switch (input.tag) {
    case "FromRequest":
      return { from: "request", request: itfInt(input.value) };
    case "FromArtifactOf":
      return { from: "artifact", job: itfInt(input.value) };
    case "FromIssue":
      return { from: "issue", issue: itfInt(input.value) };
    default:
      throw new Error(`unknown spec input ${input.tag}`);
  }
}

function specJob(value: unknown): SpecJob {
  return {
    input: specInput(itfField(value, "input")),
    tasks: itfList(itfField(value, "tasks")).map((task) => ({
      role: itfOneOf(itfVariant(itfField(task, "role"))!.tag, ROLES),
      startOrder: itfInt(itfField(task, "startOrder")),
      status: itfOneOf(itfVariant(itfField(task, "status"))!.tag, TASK_STATUSES),
      restarts: itfInt(itfField(task, "restarts")),
      paused: itfBool(itfField(task, "paused")),
      turnRunning: itfBool(itfField(task, "turnRunning")),
      promptsSent: itfInt(itfField(task, "promptsSent")),
      promptsQueued: itfInt(itfField(task, "promptsQueued")),
      generationClosed: itfBool(itfField(task, "generationClosed")),
    })),
    artifact: itfOneOf(itfVariant(itfField(value, "artifact"))!.tag, ARTIFACT_STATUSES),
    refinerRuns: itfList(itfField(value, "refinerRuns")).map((run) =>
      itfOneOf(itfVariant(run)!.tag, REFINER_RUN_STATUSES),
    ),
    pullOnHost: itfOneOf(itfVariant(itfField(value, "pullOnHost"))!.tag, PULLS_ON_HOST),
  };
}

/**
 * One call the replay holds, with the step that waits on it. A model call and a page write name
 * the model turn that made them, and the task when that turn revises its page. A page write can
 * land on the host without returning.
 */
type HeldCall = {
  kind: CallKind;
  jobId: string;
  answer: (decisions: Decisions) => void;
  step: Promise<unknown> | null;
  turnId: string | null;
  revisedBy: string | null;
  land: (() => Promise<void>) | null;
};

/** A sandbox provider that holds the destroy of every author sandbox until the replay returns it. */
class HoldingSandboxProvider extends FakeSandboxProvider {
  constructor(private readonly hold: (taskId: string) => Promise<void> | null) {
    super();
  }

  override async destroy(sandbox: SandboxRef): Promise<void> {
    await super.destroy(sandbox);
    await this.hold(sandbox.id);
  }
}

/**
 * A page model that holds each call until the replay returns it, then answers with a new page and
 * a reply to each page comment its prompt carries.
 */
class HoldingPageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "holding-page";
  readonly supportedUrls = {};

  constructor(private readonly hold: () => Promise<string>) {}

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const promptText = options.prompt
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const replies = labeledPageCommentIds(promptText).flatMap((commentId) => [
      replyMarker(commentId),
      "Answered on the page.",
    ]);
    return new EchoModel([await this.hold(), ...replies].join("\n")).doGenerate(options);
  }

  async doStream(_options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const ACCEPTANCE = ["Looks good, ship it."];

/** What the decisions model answers when the acceptance check passes or does not. */
const CHECK_DECISIONS = {
  CheckPasses: () =>
    new FakeDecisions(
      { ...ANSWERS, accepts: 0.9 },
      { selected: { option: PAGE_OPTION, probability: 0.9 } },
    ),
  CheckDoesNotPass: () => new FakeDecisions({ ...ANSWERS, accepts: 0.1 }),
  CheckUnavailable: () => new FakeDecisions(new Error("the decisions model is down")),
} as const satisfies Record<CheckAnswer, () => Decisions>;

/** The kind of what `complete_job` told the agent about job `jobId`, read by its constants. */
function completionAnswerOf(jobId: string, text: string): CompletionAnswer {
  if (text.startsWith(jobDoneText(jobId))) return "Completes";
  if (text.includes(ASK_WHETHER_ACCEPTED) || text.includes(ASK_WHICH_OPTION)) return "AsksAgain";
  if (text.includes(TELL_THE_CHECK_IS_UNAVAILABLE)) return "SaysUnavailable";
  return "Refuses";
}

/** The turn end of a refiner run that approves: a reviewer's review, a judge's ruling, a polish. */
const REFINER_APPROVES: RefinerRunEnd = {
  reviewer: "approved",
  pageCommenting: "takes",
  judge: "approves",
  whileRuled: "nothing",
  polisher: "nothing_pushed",
  stopReason: "end_turn",
  closing: "reports_work",
};
const WORLD_SETUP: Omit<
  WorldSetup,
  "refiners" | "pageAuthor" | "research" | "artifact" | "origin" | "pageEnding"
> = {
  opening: "request",
  checksOnPush: "passed",
  firstInput: "request",
  subject: "none",
  sandboxStart: "at_task_start",
};

function worldAction(
  label: string,
  run: (world: WorkflowWorld) => Promise<StepFacts | void>,
): WorkflowAction {
  return { run, toString: () => label };
}

/**
 * Replays spec traces through a workflow world that opens on a person's request. Each spec action
 * maps to the entry point production uses. The destroy of an author sandbox, the acceptance
 * check of `complete_job`, and a page model call stay out until a later spec step returns them.
 */
export class WorkflowLifecycleReplay {
  private readonly calls: HeldCall[] = [];
  private stepOut: Promise<unknown> | null = null;
  private completingJobId = "";
  private heldArrived: (() => void) | null = null;
  private taken = 0;
  private readonly heldTurns = new Set<string>();
  private readonly reviseTurns = new Map<string, number>();
  private pagesWritten = 0;
  private answeredModelCall: HeldCall | null = null;
  private readonly endedIssues = new Set<number>();
  private completionAnswer: CompletionAnswer = "NotAnswered";
  private storeAtStaleAlarm: string | null = null;

  private constructor(
    readonly world: WorkflowWorld,
    private readonly modelAuthor: boolean,
    private readonly stage: string,
    private readonly selects: boolean,
  ) {}

  /** A world on the stage of `setup`, before the plan. */
  static async open(setup: SpecSetup): Promise<WorkflowLifecycleReplay> {
    setSystemTime(new Date(REPLAY_START));
    const { refiners, pageAuthor, research, artifact, origin, pageEnding } = SPEC_SETUPS[setup];
    const world = await WorkflowWorld.open({
      ...WORLD_SETUP,
      refiners,
      pageAuthor,
      research,
      artifact,
      origin,
      pageEnding,
    });
    const modelAuthor = pageAuthor === "model";
    const replay = new WorkflowLifecycleReplay(
      world,
      modelAuthor,
      STAGE_OF[artifact],
      pageEnding === "choice",
    );
    world.workflow.sandboxProvider = new HoldingSandboxProvider((taskId) =>
      replay.holdDestroy(taskId),
    );
    replay.holdPullAcceptance();
    replay.showEndedIssues();
    if (modelAuthor) {
      world.workflow.modelsByName[MODEL_AUTHOR_MODEL] = new HoldingPageModel(() =>
        replay.holdModelCall(),
      );
      const host = fakeDocumentsOf(world.workflow);
      const createPage = host.createPage.bind(host);
      const updatePageContent = host.updatePageContent.bind(host);
      host.createPage = (title, text, parent) =>
        replay.holdPageWrite(() => createPage(title, text, parent));
      host.updatePageContent = (pageId, change) =>
        replay.holdPageWrite(() => updatePageContent(pageId, change));
    }
    return replay;
  }

  /**
   * Take one spec action, then bring up every sandbox that waits. A new generation replaces the
   * bridge process of the old one, so the old socket closes first. Returns the world steps the
   * spec action took.
   */
  async take(step: TraceStep): Promise<Step[]> {
    this.taken += 1;
    this.completionAnswer = "NotAnswered";
    this.storeAtStaleAlarm = null;
    setSystemTime(new Date(REPLAY_START + this.taken * STEP_MS));
    this.world.workflow.gatewayInstance = new FakeGateway({
      decisions: new InterleavedDecisions(new FakeDecisions(ANSWERS), (questions) =>
        Object.hasOwn(questions.yesNo, "accepts") || Object.hasOwn(questions.choices, "selected")
          ? this.holdAcceptance()
          : null,
      ),
    });
    const acted = await this.world.apply(this.actionFor(step));
    const closed = await this.world.apply(
      worldAction("replaced bridges close", async (world) => {
        for (const socket of world.workflow.connections()) {
          const served = socket.state as ConnectionState;
          const sandbox = world.workflow.store.sandbox(served.task_id);
          if (sandbox && served.generation < sandbox.generation) {
            socket.close(1006, "a new generation replaced the bridge");
          }
        }
      }),
    );
    const started = await this.world.apply(
      worldAction("sandboxes come up", async (world) => {
        for (const task of world.tasksAwaitingSandbox()) {
          await this.runStep(() => world.startSandboxOf(task.task_id));
        }
      }),
    );
    return [acted, closed, started];
  }

  /** Return every held call and put the clock back. */
  async close(): Promise<void> {
    for (const call of this.calls.splice(0)) call.answer(new FakeDecisions(ANSWERS));
    setSystemTime();
  }

  /** The store as a stale alarm of the last spec action found it, or null without one. */
  storeBeforeStaleAlarm(): string | null {
    return this.storeAtStaleAlarm;
  }

  /** What `complete_job` told the agent in the last spec action taken. */
  answered(): CompletionAnswer {
    return this.completionAnswer;
  }

  /** The store as the spec sees it. */
  project(): SpecWorkflow {
    const { workflow } = this.world;
    const { store, state } = workflow;
    const jobs = store.jobs();
    const observed = this.world.steps.at(-1)?.after.tasks ?? [];
    const started = store
      .tasks()
      .filter((task) => JOB_ROLES.includes(task.role))
      .map((task) => task.task_id);
    return {
      status: WORKFLOW_STATUS_OF[state.status],
      definition: state.definition === null ? null : state.definition === SECOND_DEFINITION ? 1 : 0,
      jobSlots: state.stages.length > 0 ? state.concurrency : null,
      subject: specSubjectOf(state.subject ?? null),
      idleArmed: workflow.alarmsFor("onIdle").length > 0,
      jobs: jobs.map((job, index) => {
        const artifact = store.artifact(job.job_id);
        const runs = store.refinerRunsOf(job.job_id);
        const input = this.inputOf(job, jobs);
        return {
          input,
          tasks: store
            .tasks()
            .filter((task) => task.job_id === job.job_id && JOB_ROLES.includes(task.role))
            .map((task) => {
              const seen = observed.find((observedTask) => observedTask.task_id === task.task_id);
              const common = {
                role: task.role === "researcher" ? ("Researcher" as const) : ("Author" as const),
                startOrder: started.indexOf(task.task_id),
                status: SPEC_TASK_STATUS[task.status],
                restarts: task.restarts,
                paused: task.paused_at !== null,
              };
              if (this.modelAuthor && task.role === "author") {
                return { ...common, ...this.modelTurnsOf(task) };
              }
              return {
                ...common,
                turnRunning: store.sandbox(task.task_id)?.prompt_in_flight === 1,
                promptsSent: seen ? seen.promptTexts.length - seen.queuedPrompts : 0,
                promptsQueued: seen?.queuedPrompts ?? 0,
                generationClosed:
                  !isTaskFinished(task.status) &&
                  workflow.connections(task.task_id).length === 0 &&
                  !this.calls.some(
                    (call) => call.kind === "SandboxDestroy" && call.jobId === job.job_id,
                  ),
              };
            }),
          artifact: artifact ? ARTIFACT_STATUS_OF[artifact.status] : "NoArtifact",
          refinerRuns: runs.map((run) => REFINER_RUN_STATUS_OF[run.status]),
          pullOnHost: input.from === "issue" ? this.pullOnHostOf(index) : "NoPull",
        };
      }),
      calls: this.calls.map((call) => ({
        kind: call.kind,
        job: jobs.findIndex((job) => job.job_id === call.jobId),
      })),
      failuresPosted: workflow.posted.filter((event) => event.type === "failed").length,
      issueMoves: this.world.steps.reduce((total, step) => total + step.issueUpdates, 0),
      endedIssues: [...this.endedIssues].toSorted((left, right) => left - right),
    };
  }

  /** Where the pull the author of the job opened stands on the host. */
  private pullOnHostOf(jobIndex: number): SpecJob["pullOnHost"] {
    const jobId = this.jobOf(jobIndex).job_id;
    const author = this.world.authors.find(
      (candidate) =>
        this.world.taskOf(candidate).job_id === jobId && !this.world.continuesPull(candidate),
    );
    if (!author) return "NoPull";
    if (this.world.pullIs(author, "open")) return "PullOpen";
    if (this.world.pullIs(author, "merged")) return "PullMerged";
    if (this.world.pullIs(author, "closed")) return "PullClosed";
    return "NoPull";
  }

  /**
   * The prompts of a model-call author as the spec counts them. A revise turn sends its prompt
   * as it starts, and that prompt stays queued until the turn applies its revision. A stop ends
   * the turn and drops the queue, while its model call stays out.
   */
  private modelTurnsOf(
    task: TaskRow,
  ): Pick<SpecTask, "turnRunning" | "promptsSent" | "promptsQueued" | "generationClosed"> {
    const queued = this.world.workflow.store
      .queue()
      .filter((row) => row.task_id === task.task_id).length;
    const revising =
      !isTaskFinished(task.status) &&
      this.calls.some(
        (call) =>
          (call.kind === "ModelCall" || call.kind === "PageWrite") &&
          call.revisedBy === task.task_id &&
          call.turnId === task.model_turn_id,
      );
    return {
      turnRunning: false,
      promptsSent: this.reviseTurns.get(task.task_id) ?? 0,
      promptsQueued: revising ? queued - 1 : queued,
      generationClosed: false,
    };
  }

  private inputOf(job: JobRow, jobs: JobRow[]): SpecJob["input"] {
    const built = jobs.findIndex((earlier) => job.input_key === `artifact:${earlier.job_id}`);
    if (built !== -1) return { from: "artifact", job: built };
    const issue = ISSUE_KEYS.findIndex((key) => key === job.input_key);
    if (issue !== -1) return { from: "issue", issue };
    const continued = jobs.findIndex((earlier) => {
      const artifact = this.world.workflow.store.artifact(earlier.job_id);
      return (
        artifact !== null &&
        artifactRefKey({ ref: artifact.ref, url: artifact.external_url }) === job.input_key
      );
    });
    if (continued !== -1) return { from: "artifact", job: continued };
    const request = REQUEST_TEXTS.findIndex(
      (requestText) => jobInputKey({ kind: "request", text: requestText }) === job.input_key,
    );
    return { from: "request", request };
  }

  private actionFor(step: TraceStep): WorkflowAction {
    const { picks } = step;
    switch (step.action) {
      case "agentSetsPlan":
        return worldAction(
          `agent sets the plan of definition ${picks.definition}, with stages ${picks.withStages}`,
          (world) =>
            this.setPlan(world, {
              definition: required(picks.definition),
              withStages: required(picks.withStages),
              jobSlots: required(picks.jobSlots),
              subject: trackerLinkOf(required(picks.subjectLink)),
            }),
        );
      case "agentStartsJob":
        return worldAction(`agent starts a job on request ${picks.request}`, async (world) => {
          const requestText = REQUEST_TEXTS[required(picks.request)] ?? REQUEST_TEXTS[0];
          const { start_job } = startTools(world.workflow, [requestText]);
          await start_job.execute({ stage: this.stage, brief: "Write the design." }, TOOL_CALL);
        });
      case "agentStartsJobOnAnIssue":
        return worldAction(`agent starts a job on issue ${picks.issue}`, (world) =>
          this.runStep(async () => {
            const { start_job } = startTools(world.workflow, [REQUEST_TEXTS[0]]);
            await start_job.execute(
              {
                stage: this.stage,
                brief: "Fix the login redirect.",
                issue: ISSUE_KEYS[required(picks.issue)],
              },
              TOOL_CALL,
            );
          }),
        );
      case "agentContinuesAPull":
        return worldAction(`agent continues the pull of job ${picks.id}`, (world) =>
          this.runStep(async () => {
            const { start_job } = startTools(world.workflow, [REQUEST_TEXTS[0]]);
            const url = world.artifactUrlOf(this.worldAuthorOf(required(picks.id)));
            await start_job.execute(
              { stage: this.stage, brief: "Address the review.", artifact: url },
              TOOL_CALL,
            );
          }),
        );
      case "theHostMovesAPull":
        return worldAction(
          `the host moves the pull of job ${picks.id}: ${picks.hostMove}`,
          (world) =>
            this.runStep(() =>
              this.hostMovesPull(world, required(picks.id), required(picks.hostMove)),
            ),
        );
      case "aPersonEndsAnIssue":
      case "aPersonEndsAnIssueAfterAnAcceptance":
        return worldAction(`a person ends issue ${picks.issue}`, (world) =>
          this.runStep(() => this.personEndsIssue(world, required(picks.issue))),
        );
      case "researcherHandsOver":
        return worldAction(`researcher of job ${picks.id} hands over`, (world) =>
          researcherTurnEnds(this.unfinishedResearcherIndexOf(required(picks.id)), "written").run(
            world,
          ),
        );
      case "authorWritesItsPage":
        return worldAction(`author of job ${picks.id} writes its page`, async (world) => {
          const index = this.unfinishedIndexOf(required(picks.id));
          await firstArtifactAppears(index, "author_text").run(world);
          await authorTurnEnds(index, "same", "finished").run(world);
        });
      case "authorLinksItsIssues":
        return worldAction(`author of job ${picks.id} links its issues`, async (world) => {
          const index = this.unfinishedIndexOf(required(picks.id));
          const link = trackerLinkOf(required(picks.outputLink));
          if (!link) throw new Error("the spec output links no subject");
          await firstArtifactAppears(index, "author_text", link).run(world);
          await authorTurnEnds(index, "same", "finished").run(world);
        });
      case "refinerRunEnds":
        return worldAction(`refiner run of job ${picks.id} approves`, (world) =>
          endRefinerRunTurn(world, this.worldAuthorOf(required(picks.id)), REFINER_APPROVES, 0),
        );
      case "refinerRunFails":
        return worldAction(`refiner run of job ${picks.id} fails`, (world) =>
          this.runStep(() =>
            failTask(world.workflow, this.refinerRunOf(required(picks.id)), "the sandbox died"),
          ),
        );
      case "agentPausesAuthor":
      case "agentResumesAuthor":
        return worldAction(`${step.action} of job ${picks.id}`, (world) =>
          this.runStep(async () => {
            const call = step.action === "agentPausesAuthor" ? "pause_task" : "resume_task";
            const task = this.taskOf(required(picks.id));
            await taskTools(world.workflow)[call].execute({ task_id: task.task_id }, TOOL_CALL);
          }),
        );
      case "agentPromptsAuthor":
        return worldAction(`agent prompts the task of job ${picks.id}`, (world) =>
          this.runStep(async () => {
            const task = this.taskOf(required(picks.id));
            await taskTools(world.workflow).prompt_task.execute(
              { task_id: task.task_id, text: "Add a test for it." },
              TOOL_CALL,
            );
          }),
        );
      case "personSendsAVerbalCommand": {
        const command = required(picks.command);
        return worldAction(`a person says ${command}`, (world) =>
          this.runStep(() =>
            world.deliver({
              kind: "prompt",
              text: VERBAL_COMMAND_TEXT[command],
              reply_to: world.workflow.state.origin ?? undefined,
            }),
          ),
        );
      }
      case "taskStalls":
        return worldAction(`task of job ${picks.id} stalls`, (world) =>
          this.taskStalls(world, required(picks.id)),
        );
      case "agentCancelsJob":
        return worldAction(`agent cancels job ${picks.id}`, (world) =>
          this.runStep(async () => {
            const { cancel_job } = startTools(world.workflow);
            const jobId = this.jobOf(required(picks.id)).job_id;
            await cancel_job.execute({ job_id: jobId, reason: "a person asked" }, TOOL_CALL);
          }),
        );
      case "agentCompletesJob":
        return worldAction(`agent completes job ${picks.id}`, (world) =>
          this.runStep(async () => {
            const { complete_job } = startTools(world.workflow, ACCEPTANCE);
            const jobId = this.jobOf(required(picks.id)).job_id;
            this.completingJobId = jobId;
            const option = this.selects ? { option: PAGE_OPTION } : {};
            const answer = await complete_job.execute(
              { job_id: jobId, result: "Done.", ...option },
              TOOL_CALL,
            );
            this.completionAnswer = completionAnswerOf(jobId, toolText(answer));
          }),
        );
      case "acceptanceCheckReturns": {
        const checkAnswer = required(picks.checkAnswer);
        return worldAction(`acceptance check ${picks.callId} returns ${checkAnswer}`, (world) => {
          const callId = required(picks.callId);
          if (checkAnswer === "CheckPasses") this.mergeWithoutAnEvent(world, callId);
          return this.returnCall(callId, CHECK_DECISIONS[checkAnswer]());
        });
      }
      case "sandboxDestroyReturns":
        return worldAction(`sandbox destroy ${picks.callId} returns`, () =>
          this.returnCall(required(picks.callId), new FakeDecisions(ANSWERS)),
        );
      case "modelCallReturns":
        return worldAction(`model call ${picks.callId} returns`, () =>
          this.returnCall(required(picks.callId), new FakeDecisions(ANSWERS)),
        );
      case "pageWriteReturns":
        return worldAction(`page write ${picks.callId} returns`, () =>
          this.returnCall(required(picks.callId), new FakeDecisions(ANSWERS)),
        );
      case "modelTurnOutlivesItsDeadline":
        return worldAction(`the deadline of model call ${picks.callId} passes`, (world) =>
          this.modelTurnOutlivesItsDeadline(world, required(picks.callId)),
        );
      case "personWrites":
        return personWrites("prompt");
      case "aPersonPressesStop":
        return personPressesStop(0);
      case "workflowEnds":
        return worldAction(`the workflow ends: ${picks.ending}`, (world) =>
          this.runStep(() => this.endWorkflow(world, required(picks.ending))),
        );
      case "idleAlarmFires":
        return timerFires("idle", 0);
      case "staleAlarmFires": {
        const stale = staleAlarmFires(required(picks.timer), required(picks.sandbox));
        return worldAction(String(stale), (world) => {
          this.storeAtStaleAlarm = world.storeSnapshot();
          return stale.run(world);
        });
      }
      case "aStaleModelTurnDeadlineFires":
        return worldAction(`a stale model turn deadline of job ${picks.id} fires`, (world) =>
          this.staleModelTurnDeadlineFires(world, required(picks.id)),
        );
      case "workflowRestarts":
        return worldAction(
          `the workflow restarts, and a page write out ${picks.landed ? "landed" : "did not land"}`,
          (world) => this.restart(world, required(picks.landed)),
        );
      default:
        throw new Error(`no world action for spec action ${step.action}`);
    }
  }

  private async setPlan(
    world: WorkflowWorld,
    {
      definition,
      withStages,
      jobSlots,
      subject,
    }: { definition: number; withStages: boolean; jobSlots: number; subject: TrackerLink | null },
  ): Promise<void> {
    const name =
      definition === 2
        ? UNDECLARED_DEFINITION
        : definition === 1
          ? SECOND_DEFINITION
          : (world.workflow.workflowDefinitions()[0]?.name ?? "");
    const stages = {
      stages: [this.stage],
      repo: REPO,
      page_parent: this.modelAuthor ? PAGE_PARENT : null,
      concurrency: jobSlots,
    };
    const { set_plan } = planTools(world.workflow);
    await set_plan.execute(
      {
        name: "Fix login",
        definition: name,
        reason: "the request asks for a design",
        ...(withStages ? stages : {}),
        ...(subject ? { subject: world.trackerLinkUrl(subject, 0) } : {}),
      },
      TOOL_CALL,
    );
  }

  private async endWorkflow(world: WorkflowWorld, ending: Ending): Promise<void> {
    switch (ending) {
      case "PersonCancels":
        await personCancels(
          world.workflow.state.origin?.source === "tracker" ? "word" : "control",
        ).run(world);
        return;
      case "AgentFails":
        await planTools(world.workflow).fail_workflow.execute(
          { reason: "The repository cannot be built." },
          TOOL_CALL,
        );
        return;
      case "AgentFinishes":
        await planTools(world.workflow).finish_workflow.execute(
          { result: "The design is written." },
          TOOL_CALL,
        );
        return;
      default: {
        const unreachable: never = ending;
        throw new Error(`unhandled ending ${String(unreachable)}`);
      }
    }
  }

  /** A person moves the pull of the job on the host, and the host tells the workflow. */
  private async hostMovesPull(
    world: WorkflowWorld,
    jobIndex: number,
    hostMove: HostMove,
  ): Promise<void> {
    const author = this.worldAuthorOf(jobIndex);
    const detail = world.pullDetailOf(author);
    switch (hostMove) {
      case "Merged":
      case "ClosedUnmerged": {
        const merged = hostMove === "Merged";
        world.movePull(author, merged ? "merged" : "closed");
        await world.deliver({
          kind: "pr_event",
          text: "",
          pull: { ...detail, action: "closed", merged },
        });
        return;
      }
      case "Reopened":
        world.movePull(author, "open");
        await world.deliver({
          kind: "pr_event",
          text: "",
          pull: { ...detail, action: "reopened" },
        });
        return;
      default: {
        const unreachable: never = hostMove;
        throw new Error(`unhandled host move ${String(unreachable)}`);
      }
    }
  }

  /** A person moves the issue to canceled on the tracker, and the tracker tells the workflow. */
  private async personEndsIssue(world: WorkflowWorld, issue: number): Promise<void> {
    this.endedIssues.add(issue);
    const key = ISSUE_KEYS[issue];
    if (!key) throw new Error(`the spec names no issue ${issue}`);
    await world.deliver({
      kind: "control",
      control: "cancel",
      text: `Issue moved to ${CANCELED_STATE.name}`,
      bindings: [{ source: "tracker_issue", external_id: key }],
    });
  }

  /**
   * A pick that accepts the check on an open pull means the host merged it, and its event did not
   * reach the workflow.
   */
  private mergeWithoutAnEvent(world: WorkflowWorld, callId: number): void {
    const call = this.calls[callId];
    if (call?.kind !== "AcceptanceCheck" || this.stage !== STAGE_OF.pull) return;
    const artifact = world.workflow.store.artifact(call.jobId);
    if (artifact?.ref.kind !== "pull") return;
    const number = artifact.ref.number;
    const opener = world.authors.find((author) => author.pullNumber === number);
    if (opener && world.pullIs(opener, "open")) world.movePull(opener, "merged");
  }

  /** Hold the host's answer to whether it merged a pull, which `complete_job` asks. */
  private holdPullAcceptance(): void {
    this.world.workflow.artifact = (kind) => {
      const built = FakeRuntime.prototype.artifact.call(this.world.workflow, kind);
      const accepted = built.accepted?.bind(built);
      if (!accepted) return built;
      return {
        ...built,
        accepted: (ref) => {
          const jobId = this.completingJobId;
          return new Promise<boolean>((resolve, reject) => {
            this.hold({
              kind: "AcceptanceCheck",
              jobId,
              answer: () => {
                accepted(ref).then(resolve, reject);
              },
              turnId: null,
              revisedBy: null,
              land: null,
            });
          });
        },
      };
    };
  }

  /** The tracker shows each issue a person ended as canceled. */
  private showEndedIssues(): void {
    const tracker = this.world.workflow.trackerInstance;
    if (!tracker) return;
    const read = tracker.issue.bind(tracker);
    tracker.issue = async (idOrKey) => {
      const issue = await read(idOrKey);
      const ended = [...this.endedIssues].some((index) => ISSUE_KEYS[index] === issue?.id);
      return issue && ended ? { ...issue, state: CANCELED_STATE } : issue;
    };
  }

  private async taskStalls(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const task = this.taskOf(jobIndex);
    const sandbox = world.workflow.store.requireSandbox(task.task_id);
    const alarm = { task_id: task.task_id, generation: sandbox.generation };
    if (!sandbox.nudged) await onNoProgress(world.workflow, alarm);
    await this.runStep(() => onNoProgress(world.workflow, alarm));
  }

  /**
   * The Durable Object restarts and every held call is lost. A page write that landed changes
   * the page on the host first. Each model turn the start step arms for now resumes in its own
   * step, so a resumed turn whose model call is held does not hold the next one back.
   */
  private async restart(world: WorkflowWorld, landed: boolean): Promise<void> {
    const lost = this.calls.splice(0);
    if (landed) {
      for (const call of lost) await call.land?.();
    }
    await this.runStep(() => workflowRestarts().run(world));
    const due = world.workflow
      .alarmsFor("onModelTurnDeadline")
      .filter((alarm) => alarm.delay === 0);
    for (const alarm of due) {
      await world.workflow.cancelAlarm(alarm.id);
      await this.runStep(() =>
        onModelTurnDeadline(world.workflow, alarm.payload as ModelTurnAlarm),
      );
    }
  }

  /** The deadline of a held model call or page write fires first. The call never returns. */
  private async modelTurnOutlivesItsDeadline(world: WorkflowWorld, callId: number): Promise<void> {
    const [call] = this.calls.splice(callId, 1);
    if (!call?.turnId) throw new Error(`no model turn call ${callId} is out`);
    const deadline = world.workflow
      .alarmsFor("onModelTurnDeadline")
      .find((alarm) => (alarm.payload as ModelTurnAlarm).turn_id === call.turnId);
    if (!deadline) throw new Error(`model turn ${call.turnId} has no deadline armed`);
    await world.workflow.cancelAlarm(deadline.id);
    await this.runStep(() =>
      onModelTurnDeadline(world.workflow, deadline.payload as ModelTurnAlarm),
    );
  }

  /**
   * The deadline alarm of a model turn of the job that already ended fires. The alarm leaves the
   * list before it runs, as an alarm the platform delivers does.
   */
  private async staleModelTurnDeadlineFires(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const task = this.taskOf(jobIndex);
    const stale = world.workflow.alarmsFor("onModelTurnDeadline").find((alarm) => {
      const { task_id, turn_id } = alarm.payload as ModelTurnAlarm;
      return task_id === task.task_id && turn_id !== task.model_turn_id;
    });
    if (!stale) throw new Error(`job ${jobIndex} has no deadline armed for a turn that ended`);
    await world.workflow.cancelAlarm(stale.id);
    this.storeAtStaleAlarm = world.storeSnapshot();
    await onModelTurnDeadline(world.workflow, stale.payload as ModelTurnAlarm);
  }

  /** Run a step until it ends or a call it makes is held. */
  private async runStep(step: () => Promise<unknown>): Promise<void> {
    const held = new Promise<"held">((resolve) => {
      this.heldArrived = () => resolve("held");
    });
    const started: { running: Promise<unknown> | null } = { running: null };
    this.stepOut = Promise.resolve().then(() => started.running);
    const running = step();
    started.running = running;
    await Promise.race([held, running]);
    this.heldArrived = null;
    this.stepOut = null;
  }

  private async returnCall(callId: number, decisions: Decisions): Promise<void> {
    const [call] = this.calls.splice(callId, 1);
    if (!call) throw new Error(`no call ${callId} is out`);
    const rest = call.step;
    this.answeredModelCall = call.kind === "ModelCall" ? call : null;
    await this.runStep(async () => {
      call.answer(decisions);
      await rest;
    });
    this.answeredModelCall = null;
  }

  /**
   * Hold the destroy of the sandbox of an author that ended or restarts. A polisher closes the
   * container of an author as it starts, and the spec folds that destroy into the step.
   */
  private holdDestroy(taskId: string): Promise<void> | null {
    const task = this.world.workflow.store.task(taskId);
    if (task?.role !== "author") return null;
    if (!isTaskFinished(task.status) && task.status !== "queued") return null;
    return new Promise<void>((release) => {
      this.hold({
        kind: "SandboxDestroy",
        jobId: task.job_id,
        answer: () => release(),
        turnId: null,
        revisedBy: null,
        land: null,
      });
    });
  }

  private holdAcceptance(): Promise<Decisions | null> {
    const jobId = this.completingJobId;
    return new Promise<Decisions | null>((release) => {
      this.hold({
        kind: "AcceptanceCheck",
        jobId,
        answer: release,
        turnId: null,
        revisedBy: null,
        land: null,
      });
    });
  }

  /**
   * Hold the page model call of the model turn that just started. It answers with a page text no
   * earlier answer had, so each revision changes the page.
   */
  private holdModelCall(): Promise<string> {
    const { store } = this.world.workflow;
    const task = store
      .tasks()
      .find((candidate) => candidate.model_turn_id && !this.heldTurns.has(candidate.model_turn_id));
    if (!task?.model_turn_id) throw new Error("a page model call went out without a model turn");
    this.heldTurns.add(task.model_turn_id);
    const revises = store.artifact(task.job_id) !== null;
    if (revises) this.reviseTurns.set(task.task_id, (this.reviseTurns.get(task.task_id) ?? 0) + 1);
    this.pagesWritten += 1;
    const page = `# Sessions\n\nVersion ${this.pagesWritten} of the page.\n\n${CLOSING_TEXT_MARKER}\nRevised the page.`;
    return new Promise<string>((release) => {
      this.hold({
        kind: "ModelCall",
        jobId: task.job_id,
        answer: () => release(page),
        turnId: task.model_turn_id,
        revisedBy: revises ? task.task_id : null,
        land: null,
      });
    });
  }

  /**
   * Hold the page write of the model turn whose model call just returned, until the replay
   * returns it. Any other write to the host goes through at once.
   */
  private holdPageWrite<Result>(write: () => Promise<Result>): Promise<Result> {
    const modelCall = this.answeredModelCall;
    if (!modelCall) return write();
    this.answeredModelCall = null;
    return new Promise<Result>((resolve, reject) => {
      this.hold({
        kind: "PageWrite",
        jobId: modelCall.jobId,
        answer: () => {
          write().then(resolve, reject);
        },
        turnId: modelCall.turnId,
        revisedBy: modelCall.revisedBy,
        land: async () => {
          await write();
        },
      });
    });
  }

  private hold(call: Omit<HeldCall, "step">): void {
    this.calls.push({ ...call, step: this.stepOut });
    this.heldArrived?.();
  }

  private jobOf(jobIndex: number): JobRow {
    const job = this.world.workflow.store.jobs()[jobIndex];
    if (!job) throw new Error(`the world has no job ${jobIndex}`);
    return job;
  }

  /** The world author of the job. */
  private worldAuthorOf(jobIndex: number): WorldAuthor {
    const jobId = this.jobOf(jobIndex).job_id;
    const author = this.world.authors.find(
      (candidate) => this.world.taskOf(candidate).job_id === jobId,
    );
    if (!author) throw new Error(`job ${jobIndex} has no author`);
    return author;
  }

  /** The unfinished refiner run of the job. */
  private refinerRunOf(jobIndex: number): TaskRow {
    const run = this.world.workflow.store
      .refinerRunsOf(this.jobOf(jobIndex).job_id)
      .findLast((candidate) => !isTaskFinished(candidate.status));
    if (!run) throw new Error(`job ${jobIndex} has no unfinished refiner run`);
    return run;
  }

  /** The task of the job now: its author once the researcher handed over, else its researcher. */
  private taskOf(jobIndex: number): TaskRow {
    return this.world.workflow.store.authorOrResearcherTaskOf(this.jobOf(jobIndex).job_id);
  }

  /** The index `researcherAt` counts the researcher of the job by, among the unfinished ones. */
  private unfinishedResearcherIndexOf(jobIndex: number): number {
    const jobId = this.jobOf(jobIndex).job_id;
    return this.world.workflow.store
      .tasks()
      .filter((task) => task.role === "researcher" && !isTaskFinished(task.status))
      .findIndex((task) => task.job_id === jobId);
  }

  /** The index `authorAt` counts the author of the job by, among the unfinished authors. */
  private unfinishedIndexOf(jobIndex: number): number {
    const taskId = this.taskOf(jobIndex).task_id;
    return this.world.authors
      .filter((author) => !isTaskFinished(this.world.taskOf(author).status))
      .findIndex((author) => author.taskId === taskId);
  }
}

function specSubjectOf(subject: Subject | null): SpecSubject {
  if (!subject) return { kind: "none" };
  if (subject.kind === "project") return { kind: "project" };
  return { kind: "issue", issue: ISSUE_KEYS.findIndex((key) => key === subject.issue_id) };
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the spec action is missing a pick");
  return value;
}

const SPEC_TASK_STATUS: Record<TaskStatus, SpecTask["status"]> = {
  queued: "Busy",
  provisioning: "Busy",
  working: "Busy",
  in_review: "InReview",
  done: "TaskDone",
  cancelled: "TaskCancelled",
  failed: "TaskFailed",
};

/** The spec status of a refiner run. */
const REFINER_RUN_STATUS_OF: Record<TaskStatus, SpecJob["refinerRuns"][number]> = {
  queued: "RefinerRunning",
  provisioning: "RefinerRunning",
  working: "RefinerRunning",
  in_review: "RefinerRunning",
  done: "RefinerDone",
  cancelled: "RefinerCancelled",
  failed: "RefinerFailed",
};

const ARTIFACT_STATUS_OF: Record<ArtifactRow["status"], SpecJob["artifact"]> = {
  drafted: "Drafted",
  ready: "Ready",
  accepted: "Accepted",
  removed: "Removed",
};

const WORKFLOW_STATUS_OF: Record<WorkflowStatus, SpecWorkflow["status"]> = {
  new: "New",
  running: "Running",
  waiting_input: "WaitingInput",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
