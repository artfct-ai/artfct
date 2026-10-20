import { mock, setSystemTime } from "bun:test";
import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type {
  InitializeResponse,
  NewSessionResponse,
  PlanEntry,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  SetSessionConfigOptionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { CompatRoute, Decisions } from "@artfct-ai/adapters/gateway/types";
import {
  CLAUDE_CODE_STEERING_METHOD,
  ClaudeCodeSteering,
} from "@artfct-ai/adapters/harness/claude-code/steering";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { MockHarness } from "@artfct-ai/adapters/test/mock-harness";
import { bridgeTokenHeaders } from "@artfct-ai/acp/bridge-token";
import {
  isNotification,
  isRequest,
  isResponse,
  jsonRpcErrorResponse,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  parseMessage,
  type JsonRpcMessage,
} from "@artfct-ai/acp/jsonrpc";
import {
  AgentMethods,
  BridgeMethods,
  ClientMethods,
  type BridgeExitParams,
  type BridgeHelloParams,
} from "@artfct-ai/acp/methods";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import { startTools } from "../src/agent/tools/start/start";
import type { Env } from "../src/env";
import type { SandboxRef, SandboxStartSpec } from "../src/sandbox/spec";
import { pauseTask, resumeTask, stopAuthor } from "../src/workflow/inbound/controls";
import { openEntryCount } from "../src/workflow/board/render";
import type { RpcPurpose } from "../src/workflow/store/schema";
import type { TaskRow } from "../src/workflow/store/tasks";
import {
  acceptBridge,
  authorizeBridge,
  LOST_SANDBOX_TEXT,
  onBridgeClosed,
  onBridgeLost,
  onBridgeMessage,
  type ConnectionState,
} from "../src/workflow/task/harness/bridge";
import { bridgeDialUrl } from "../src/workflow/task/harness/bridge-path";
import { instructTask, retryQueue } from "../src/workflow/task/harness/prompt-queue";
import {
  keepSandboxAlive,
  NUDGE_TEXT,
  onHelloTimeout,
  onNoProgress,
  onWallClock,
  type GenerationAlarm,
  type TaskAlarm,
} from "../src/workflow/task/harness/timers";
import { GAVE_UP_RESTART_TEXT, settleIdleAuthor } from "../src/workflow/task/harness/turn";
import { provision, sandboxStartInFlight } from "../src/workflow/task/sandbox/sandbox";
import { taskAtWork } from "../src/workflow/task/at-work";
import { fakeConnection, type FakeAlarm, type FakeSocket } from "./fake-runtime";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { FakeSandboxProvider } from "./fake-sandbox";
import { InterleavedDecisions } from "./interleaved-decisions";
import { quintTraces } from "./quint-traces";
import { WorkflowWorld, type WorldSetup } from "./workflow-world";

await mock.module("../src/agent/model/traced-ai", async () => ({ tracedAI: await import("ai") }));

/**
 * The setup modules of the harness session spec: whether the stage of each asks for an effort, and
 * whether it gives the job its own branch.
 */
export const SPEC_SETUPS = {
  harnessDefaultEffort: { asksEffort: false, bindsABranch: false },
  stageAsksForEffort: { asksEffort: true, bindsABranch: false },
  agentPausesRunningTurns: { asksEffort: false, bindsABranch: false },
  interruptionsAfterTheFirstPrompt: { asksEffort: false, bindsABranch: false },
  jobOnABranch: { asksEffort: false, bindsABranch: true },
} as const satisfies Record<string, { asksEffort: boolean; bindsABranch: boolean }>;

/** The name of one setup module of the spec. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

const REPLAY_START = Date.parse("2026-01-01T00:00:00.000Z");
const PAST_THE_RECONNECT_CEILING_MS = 31_000;
const RECONNECT_CEILING_MS = 30_000;

const TASK_STATUSES = [
  "Queued",
  "Provisioning",
  "Working",
  "InReview",
  "Cancelled",
  "Failed",
  "Done",
] as const;
const PROMPT_KINDS = [
  "PersonPrompt",
  "ContinuePrompt",
  "NudgePrompt",
  "GaveUpWake",
  "LostSandboxWake",
  "FirstPrompt",
] as const;
const RPC_PURPOSES = ["Initialize", "SessionNew", "SetEffort", "Prompt", "Steer"] as const;
const STEER_STATUSES = ["SteerOut", "SteerTaken"] as const;
const STAMPS = ["Unset", "Recent", "Old"] as const;
const SOCKET_STATES = [
  "Connected",
  "BridgeGone",
  "ClosingReplaced",
  "ClosingContainer",
  "ClosingBridgeGone",
] as const;
const CALL_STATES = ["Out", "Dropped"] as const;
const OUTCOMES = ["Finished", "WaitsOnPerson", "Blocked", "StoppedEarly"] as const;
const FINISHED_STOPS = ["EndTurn", "MaxTokens"] as const;
const PROGRESS_REPORTS = ["ToolCall", "OpenTodoList", "FinishedTodoList"] as const;

type SpecStatus = (typeof TASK_STATUSES)[number];
type SpecPurpose = (typeof RPC_PURPOSES)[number];
type SpecSteerStatus = (typeof STEER_STATUSES)[number];
type SocketState = (typeof SOCKET_STATES)[number];
type CallState = (typeof CALL_STATES)[number];
type Outcome = (typeof OUTCOMES)[number];
type FinishedStop = (typeof FINISHED_STOPS)[number];
type ProgressReport = (typeof PROGRESS_REPORTS)[number];

/**
 * A queued prompt as the spec sees it: its kind, and for a person prompt which of the person's
 * prompts it is, such as `PersonPrompt(1)`.
 */
type SpecPrompt = string;

/** A request a bridge passed to its harness, as the spec sees it. `carries` names its person prompt. */
type SpecRequest = { id: number; purpose: SpecPurpose; cancelled: boolean; carries: number | null };

/** A steered person prompt and the request that carried it, as the spec sees it. */
type SpecSteer = { person: number; rpc: number; status: SpecSteerStatus };

/** One bridge process, as the spec sees it. `current` says it carries the task's token. */
type SpecBridge = {
  generation: number;
  current: boolean;
  alive: boolean;
  saidHello: boolean;
  requests: SpecRequest[];
};

/** One socket between the orchestrator and a bridge, as the spec sees it. */
type SpecSocket = { bridge: number; generation: number; state: SocketState };

/** One call the orchestrator awaits, as the spec sees it. */
type SpecCall =
  | { id: number; kind: "BranchBinding"; state: CallState }
  | { id: number; kind: "SandboxStart"; generation: number; launched: boolean; state: CallState }
  | { id: number; kind: "SandboxDestroy"; upTo: number; state: CallState }
  | {
      id: number;
      kind: "OutcomeCheck";
      promptsAtTurnEnd: number;
      generation: number;
      state: CallState;
    }
  | { id: number; kind: "Summarization"; state: CallState };

/**
 * Where each schedule column points: the index of its alarm among the alarms, -1 for an alarm
 * that already went, or null when the column is empty.
 */
type SpecSlots = {
  hello: number | null;
  noProgress: number | null;
  wall: number | null;
  keepAlive: number | null;
};

/** The task, its sandbox, the sockets and bridges around it, and the calls out, as the spec sees them. */
export type SpecTask = {
  status: SpecStatus;
  restarts: number;
  paused: boolean;
  generation: number;
  session: boolean;
  hadPrompt: boolean;
  promptInFlight: boolean;
  nudged: boolean;
  stoppedEarly: boolean;
  turnText: boolean;
  openTodos: boolean;
  bridgeClosedAt: (typeof STAMPS)[number];
  queue: SpecPrompt[];
  rpcs: { id: number; purpose: SpecPurpose }[];
  steers: SpecSteer[];
  delivered: number[];
  receivedTwice: number;
  artifact: boolean;
  alarms: string[];
  slots: SpecSlots;
  startsOut: number[];
  sockets: SpecSocket[];
  bridges: SpecBridge[];
  calls: SpecCall[];
  promptsSent: number;
  cancelsDelivered: number;
  permissionsAsked: number;
  permissionsWithAnAllowOption: number;
  permissionsAllowed: number;
  socketsClosed: number;
  agentWakes: number;
  eventsThatThrew: number;
  lostTurns: number;
  stopsEnded: number;
  answersToOtherRequests: number;
};

/** The values the spec picked for one action. */
type SpecPicks = {
  alarmIndex: number | null;
  callId: number | null;
  ok: boolean | null;
  outcome: Outcome | null;
  bridge: number | null;
  index: number | null;
  finished: FinishedStop | null;
  endsWithText: boolean | null;
  report: ProgressReport | null;
  offersAllow: boolean | null;
  beforeItsTurnStarts: boolean | null;
};

/** One state of a trace: the action that led to it, its picks, and the task. */
export type TraceStep = { action: string; picks: SpecPicks; task: SpecTask };

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces(
    {
      spec: "harness-session",
      setup,
      count,
      steps: TRACE_STEPS,
      seed,
    },
    (trace) => traceSteps(setup, trace),
  );
}

/** The steps of one ITF trace of a setup, such as a pinned one. */
export function traceSteps(setup: SpecSetup, trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const picks = itfField(state, "mbt::nondetPicks");
    const picked = (name: string) => {
      const pick = itfVariant(itfField(picks, name, true));
      return pick?.tag === "Some" ? pick.value : null;
    };
    const ok = picked("ok");
    const outcome = picked("outcome");
    const finished = picked("finished");
    const endsWithText = picked("endsWithText");
    const report = picked("report");
    const offersAllow = picked("offersAllow");
    const beforeItsTurnStarts = picked("beforeItsTurnStarts");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        alarmIndex: optionalInt(picked("alarmIndex")),
        callId: optionalInt(picked("callId")),
        ok: ok === null ? null : itfBool(ok),
        outcome: outcome === null ? null : itfOneOf(itfVariant(outcome)!.tag, OUTCOMES),
        bridge: optionalInt(picked("bridge")),
        index: optionalInt(picked("index")),
        finished: finished === null ? null : itfOneOf(itfVariant(finished)!.tag, FINISHED_STOPS),
        endsWithText: endsWithText === null ? null : itfBool(endsWithText),
        report: report === null ? null : itfOneOf(itfVariant(report)!.tag, PROGRESS_REPORTS),
        offersAllow: offersAllow === null ? null : itfBool(offersAllow),
        beforeItsTurnStarts: beforeItsTurnStarts === null ? null : itfBool(beforeItsTurnStarts),
      },
      task: specTask(itfField(state, `${setup}::harnessSession::world`)),
    };
  });
}

function optionalInt(value: unknown): number | null {
  return value === null ? null : itfInt(value);
}

function specTask(world: unknown): SpecTask {
  const token = itfInt(itfField(world, "token"));
  const alarms = itfList(itfField(world, "alarms"));
  const alarmIds = alarms.map((alarm) => itfInt(itfField(alarm, "id")));
  const slot = (name: string): number | null => {
    const armed = itfVariant(itfField(world, name))!;
    return armed.tag === "Armed" ? alarmIds.indexOf(itfInt(armed.value)) : null;
  };
  return {
    status: itfOneOf(tagOf(itfField(world, "status")), TASK_STATUSES),
    restarts: itfInt(itfField(world, "restarts")),
    paused: itfBool(itfField(world, "paused")),
    generation: itfInt(itfField(world, "generation")),
    session: itfBool(itfField(world, "session")),
    hadPrompt: itfBool(itfField(world, "hadPrompt")),
    promptInFlight: itfBool(itfField(world, "promptInFlight")),
    nudged: itfBool(itfField(world, "nudged")),
    stoppedEarly: itfBool(itfField(world, "stoppedEarly")),
    turnText: itfBool(itfField(world, "turnText")),
    openTodos: itfBool(itfField(world, "openTodos")),
    bridgeClosedAt: itfOneOf(tagOf(itfField(world, "bridgeClosedAt")), STAMPS),
    queue: itfList(itfField(world, "queue")).map(specPrompt),
    rpcs: itfList(itfField(world, "rpcs")).map((row) => ({
      id: itfInt(itfField(row, "id")),
      purpose: itfOneOf(tagOf(itfField(row, "purpose")), RPC_PURPOSES),
    })),
    steers: sortedSteers(
      itfSet(itfField(world, "steers")).map((row) => ({
        person: itfInt(itfField(row, "person")),
        rpc: itfInt(itfField(row, "rpc")),
        status: itfOneOf(tagOf(itfField(row, "status")), STEER_STATUSES),
      })),
    ),
    delivered: sortedPersons(itfSet(itfField(world, "delivered")).map(itfInt)),
    receivedTwice: itfInt(itfField(world, "receivedTwice")),
    artifact: itfBool(itfField(world, "artifact")),
    alarms: alarms.map((alarm) => specAlarmKind(itfField(alarm, "kind"))),
    slots: {
      hello: slot("helloSlot"),
      noProgress: slot("noProgressSlot"),
      wall: slot("wallSlot"),
      keepAlive: slot("keepAliveSlot"),
    },
    startsOut: specStartsOut(itfList(itfField(world, "calls"))),
    sockets: itfList(itfField(world, "sockets")).map((socket) => ({
      bridge: itfInt(itfField(socket, "bridge")),
      generation: itfInt(itfField(socket, "generation")),
      state: itfOneOf(tagOf(itfField(socket, "state")), SOCKET_STATES),
    })),
    bridges: itfList(itfField(world, "bridges")).map((bridge) => ({
      generation: itfInt(itfField(bridge, "generation")),
      current: itfInt(itfField(bridge, "token")) === token,
      alive: itfBool(itfField(bridge, "alive")),
      saidHello: itfBool(itfField(bridge, "saidHello")),
      requests: itfList(itfField(bridge, "requests")).map((request) => ({
        id: itfInt(itfField(request, "id")),
        purpose: itfOneOf(tagOf(itfField(request, "purpose")), RPC_PURPOSES),
        cancelled: itfBool(itfField(request, "cancelled")),
        carries: specCarried(itfField(request, "carries")),
      })),
    })),
    calls: itfList(itfField(world, "calls")).map(specCall),
    promptsSent: itfInt(itfField(world, "promptsSent")),
    cancelsDelivered: itfInt(itfField(world, "cancelsDelivered")),
    permissionsAsked: itfInt(itfField(world, "permissionsAsked")),
    permissionsWithAnAllowOption: itfInt(itfField(world, "permissionsWithAnAllowOption")),
    permissionsAllowed: itfInt(itfField(world, "permissionsAllowed")),
    socketsClosed: itfInt(itfField(world, "socketsClosed")),
    agentWakes: itfInt(itfField(world, "agentWakes")),
    eventsThatThrew: itfInt(itfField(world, "eventsThatThrew")),
    lostTurns: itfInt(itfField(world, "lostTurns")),
    stopsEnded: itfInt(itfField(world, "stopsEnded")),
    answersToOtherRequests: itfInt(itfField(world, "answersToOtherRequests")),
  };
}

function specPrompt(kind: unknown): SpecPrompt {
  const prompt = itfVariant(kind)!;
  const tag = itfOneOf(prompt.tag, PROMPT_KINDS);
  return tag === "PersonPrompt" ? personPromptKind(itfInt(prompt.value)) : tag;
}

function personPromptKind(person: number): SpecPrompt {
  return `PersonPrompt(${person})`;
}

function specCarried(carries: unknown): number | null {
  const carried = itfVariant(carries)!;
  return carried.tag === "Person" ? itfInt(carried.value) : null;
}

function sortedSteers(steers: SpecSteer[]): SpecSteer[] {
  return steers.toSorted((left, right) => left.person - right.person);
}

function sortedPersons(persons: Iterable<number>): number[] {
  return [...persons].toSorted((left, right) => left - right);
}

function specStartsOut(calls: unknown[]): number[] {
  const generations = new Set<number>();
  for (const call of calls) {
    if (tagOf(itfField(call, "state")) !== "Out") continue;
    for (const frame of itfList(itfField(call, "rest"))) {
      const named = itfVariant(frame)!;
      if (named.tag === "StartEnds") generations.add(itfInt(named.value));
    }
  }
  return [...generations].toSorted((left, right) => left - right);
}

function specAlarmKind(kind: unknown): string {
  const alarm = itfVariant(kind)!;
  return typeof alarm.value === "object" && alarm.value !== null && "#bigint" in alarm.value
    ? `${alarm.tag}(${itfInt(alarm.value)})`
    : alarm.tag;
}

function specCall(call: unknown): SpecCall {
  const kind = itfVariant(itfField(call, "kind"))!;
  const state = itfOneOf(tagOf(itfField(call, "state")), CALL_STATES);
  const id = itfInt(itfField(call, "id"));
  switch (kind.tag) {
    case "BranchBinding":
      return { id, kind: "BranchBinding", state };
    case "SandboxStart":
      return {
        id,
        kind: "SandboxStart",
        generation: itfInt(itfField(kind.value, "generation")),
        launched: itfBool(itfField(kind.value, "launched")),
        state,
      };
    case "SandboxDestroy":
      return { id, kind: "SandboxDestroy", upTo: itfInt(kind.value), state };
    case "OutcomeCheck":
      return {
        id,
        kind: "OutcomeCheck",
        promptsAtTurnEnd: itfInt(itfField(kind.value, "promptsSent")),
        generation: itfInt(itfField(kind.value, "generation")),
        state,
      };
    case "Summarization":
      return { id, kind: "Summarization", state };
    default:
      throw new Error(`the trace has a call ${kind.tag}`);
  }
}

function tagOf(value: unknown): string {
  return itfVariant(value)!.tag;
}

/**
 * One request a bridge passed to its harness. `serial` names the rpc row the orchestrator wrote for
 * it, and `carries` the person prompt in its text.
 */
type BridgeRequest = {
  id: number;
  serial: number;
  purpose: SpecPurpose;
  cancelled: boolean;
  carries: number | null;
};

/**
 * One bridge process and its harness, as the replay runs it. `received` holds the person prompts
 * its harness session received outside a cancelled turn, and `inTurn` the ones its running turn
 * received.
 */
type ReplayBridge = {
  generation: number;
  token: string;
  alive: boolean;
  saidHello: boolean;
  requests: BridgeRequest[];
  received: Set<number>;
  inTurn: Set<number>;
  turnShowedProgress: boolean;
};

/**
 * One socket the replay dialed, with the frames of it the bridge already read, and the serial of
 * the rpc row behind each request frame, by frame index.
 */
type ReplaySocket = {
  bridge: number;
  generation: number;
  state: SocketState;
  fake: FakeSocket;
  read: number;
  serials: Map<number, number>;
};

/** A promise the replay settles from a later step. */
type Gate = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

/** The two awaits of one sandbox start: the commit author lookup, then the provider's start. */
type StartAwaits = { lookup: Gate; start: Gate };

/** A held sandbox start. */
type HeldStart = { name: "SandboxStart"; generation: number; token: string; launched: boolean };

/** One call the replay holds, with the step that waits on it. */
type HeldCall = {
  id: number;
  kind:
    | { name: "BranchBinding" }
    | HeldStart
    | { name: "SandboxDestroy"; upTo: number }
    | { name: "OutcomeCheck"; promptsAtTurnEnd: number; generation: number }
    | { name: "Summarization" };
  state: CallState;
  answer: (answer: { ok: boolean; decisions: Decisions }) => void;
  step: Promise<unknown> | null;
  alarm: FakeAlarm | null;
};

/** A sandbox provider whose starts and destroys stay out until the replay returns them. */
class HoldingSandboxProvider extends FakeSandboxProvider {
  constructor(private readonly replay: HarnessSessionReplay) {
    super();
  }

  override async start(spec: SandboxStartSpec): Promise<void> {
    await super.start(spec);
    await this.replay.heldStart(spec.generation);
  }

  override async destroy(sandbox: SandboxRef): Promise<void> {
    await super.destroy(sandbox);
    await this.replay.holdDestroy();
  }

  override async bridgeRunning(_sandbox: SandboxRef, generation: number): Promise<boolean> {
    return this.replay.bridgeRuns(generation);
  }
}

/** A gateway without a route for the harness model, so a sandbox start fails before it launches. */
class RoutelessGateway extends FakeGateway {
  override compatRoute(): CompatRoute {
    throw new Error("the gateway has no route for the harness model");
  }
}

/** A model whose every summarization stays out until the replay returns it. */
class HeldSummarizationModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "held-summarization";
  readonly supportedUrls = {};

  constructor(private readonly replay: HarnessSessionReplay) {}

  async doGenerate(): Promise<LanguageModelV4GenerateResult> {
    await this.replay.holdSummarization();
    return {
      content: [{ type: "text", text: DIGEST_TEXT }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      },
      warnings: [],
    };
  }

  doStream(): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const PERSON_TEXT = "Cover the error path too.";
const PERSON_PROMPT = /Cover the error path too\. (\d+)/;
const CONTINUE_TEXT = "Continue where you left off.";
const TURN_TEXT = `I wrote the design section by section. ${"Each section names its decision and the reason for it. ".repeat(12)}`;
const DIGEST_TEXT = "The design is written.";
const OPEN_TODOS: PlanEntry[] = [
  { content: "Write the design", priority: "high", status: "in_progress" },
  { content: "Check the design", priority: "medium", status: "pending" },
];
const FINISHED_TODOS: PlanEntry[] = OPEN_TODOS.map((entry) => ({ ...entry, status: "completed" }));
const AGENT_WAKE_TEXTS = ["Harness turn ended (", "The harness is idle."];
const LOST_TURN_LINES = [
  "bridge lost with a prompt in flight. restarting the sandbox.",
  "failed: bridge lost with a prompt in flight and no restarts left",
];
const HELD_EFFORT = "low";
const ASKED_EFFORT = "high";
const INTERNAL_ERROR = -32603;
const BRANCH_BINDING_WRITE = /^insert into "bindings"/i;

const OUTCOME_OPTIONS: Record<Outcome, string> = {
  Finished: "finished",
  WaitsOnPerson: "waits_on_person",
  Blocked: "blocked",
  StoppedEarly: "stopped_early",
};

const STOP_REASONS: Record<FinishedStop, StopReason> = {
  EndTurn: "end_turn",
  MaxTokens: "max_tokens",
};

const PURPOSE_OF_METHOD: Record<string, SpecPurpose> = {
  [AgentMethods.initialize]: "Initialize",
  [AgentMethods.sessionNew]: "SessionNew",
  [AgentMethods.sessionSetConfigOption]: "SetEffort",
  [AgentMethods.sessionPrompt]: "Prompt",
  [CLAUDE_CODE_STEERING_METHOD]: "Steer",
};

const SPEC_PURPOSE: Record<RpcPurpose, SpecPurpose | null> = {
  initialize: "Initialize",
  session_new: "SessionNew",
  set_effort: "SetEffort",
  prompt: "Prompt",
  steer: "Steer",
  cancel: null,
};

const SPEC_STATUS: Record<TaskStatus, SpecStatus> = {
  queued: "Queued",
  provisioning: "Provisioning",
  working: "Working",
  in_review: "InReview",
  done: "Done",
  cancelled: "Cancelled",
  failed: "Failed",
};

const WORLD_SETUP: Omit<WorldSetup, "pageBranch"> = {
  opening: "job_unstarted",
  artifact: "page",
  refiners: "none",
  research: false,
  pageAuthor: "harness",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  origin: "chat",
  firstInput: "request",
  subject: "none",
  sandboxStart: "at_task_start",
};

function effortOption(value: string): SessionConfigOption {
  return {
    id: "effort",
    type: "select",
    name: "Effort",
    currentValue: value,
    options: [{ value, name: value }],
  };
}

/**
 * Replays spec traces through one harness author whose job has not started. Each spec action maps
 * to the entry point production uses. The replay plays the sandbox, the bridge and the harness.
 * The branch binding write, the sandbox start, the sandbox destroy and the turn outcome question
 * stay out until a later spec step returns them. A sandbox start is out from its commit author
 * lookup.
 */
export class HarnessSessionReplay {
  private calls: HeldCall[] = [];
  private readonly startAwaits = new Map<number, StartAwaits>();
  private readonly providerStartsReached = new Map<number, () => void>();
  private nextCall = 0;
  private readonly bridges: ReplayBridge[] = [];
  private sockets: ReplaySocket[] = [];
  private readonly rpcs: { id: number; purpose: SpecPurpose }[] = [];
  private stepOut: Promise<unknown> | null = null;
  private alarmOut: FakeAlarm | null = null;
  private heldArrived: (() => void) | null = null;
  private promptsSent = 0;
  private cancelsDelivered = 0;
  private permissionsAsked = 0;
  private permissionsWithAnAllowOption = 0;
  private permissionsAllowed = 0;
  private socketsClosed = 0;
  private eventsThatThrew = 0;
  private stopsEnded = 0;
  private answersToOtherRequests = 0;
  private personPrompts = 0;
  private readonly delivered = new Set<number>();
  private receivedTwice = 0;
  private rpcSerial = 0;
  private lastRpcRow: { id: number; serial: number } | null = null;
  private readonly rowSerials = new Map<number, number>();
  private answeredSerial: number | null = null;
  private permissionSeq = 0;
  private clock = REPLAY_START;

  private constructor(
    readonly world: WorkflowWorld,
    private readonly taskId: string,
  ) {}

  /** A world with one queued harness author, and a stage that asks for an effort when `setup` says so. */
  static async open(setup: SpecSetup): Promise<HarnessSessionReplay> {
    setSystemTime(new Date(REPLAY_START));
    const { asksEffort, bindsABranch } = SPEC_SETUPS[setup];
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, pageBranch: bindsABranch });
    const author = world.authors[0];
    if (!author) throw new Error("the world has no author");
    const replay = new HarnessSessionReplay(world, author.taskId);
    const { workflow } = world;
    workflow.sandboxProvider = new HoldingSandboxProvider(replay);
    workflow.modelInstance = new HeldSummarizationModel(replay);
    workflow.harnessInstance = new MockHarness(
      workflow.store.requireSandbox(author.taskId).harness,
      new ClaudeCodeSteering(),
    );
    workflow.env = { ...workflow.env, DB: replay.holdingBranchBindings(workflow.env.DB) };
    const host = workflow.code();
    if (!host) throw new Error("the world has no code host");
    const commitAuthor = host.commitAuthor.bind(host);
    host.commitAuthor = async () => {
      await replay.holdStart();
      return commitAuthor();
    };
    if (asksEffort) {
      const { orchestrator } = workflow.config();
      workflow.patchConfig({
        orchestrator: { ...orchestrator, task: { ...orchestrator.task, effort: ASKED_EFFORT } },
      });
    }
    replay.watchRpcRows();
    return replay;
  }

  /** Take one spec action, then let every bridge read what the orchestrator sent it. */
  async take(step: TraceStep): Promise<void> {
    const Gateway = step.action === "sandboxStartFailsAtOnce" ? RoutelessGateway : FakeGateway;
    this.world.workflow.gatewayInstance = new Gateway({
      decisions: new InterleavedDecisions(new FakeDecisions(ANSWERS), (questions) =>
        Object.hasOwn(questions.choices, "outcome") ? this.holdOutcomeCheck() : null,
      ),
    });
    await this.world.workBudget.within(step.action, () => this.act(step));
    this.readSentFrames();
  }

  /** Return every held call and put the clock back. */
  async close(): Promise<void> {
    const out = this.calls.filter((call) => call.state === "Out");
    this.calls = [];
    for (const call of out) call.answer({ ok: true, decisions: new FakeDecisions(ANSWERS) });
    setSystemTime();
  }

  /** The store, the sockets, the bridges and the calls as the spec sees them. */
  project(): SpecTask {
    const { workflow } = this.world;
    const { store } = workflow;
    const task = store.requireTask(this.taskId);
    const sandbox = store.requireSandbox(this.taskId);
    const alarms = workflow.alarms.filter((alarm) => specAlarmOf(alarm) !== null);
    const slot = (scheduleId: string | null): number | null =>
      scheduleId === null ? null : alarms.findIndex((alarm) => alarm.id === scheduleId);
    const closedAt = sandbox.bridge_closed_at ? Date.parse(sandbox.bridge_closed_at) : null;
    const queued = store.queue().filter((prompt) => prompt.task_id === this.taskId);
    return {
      status: SPEC_STATUS[task.status],
      restarts: task.restarts,
      paused: task.paused_at !== null,
      generation: sandbox.generation,
      session: sandbox.session_id !== null,
      hadPrompt: sandbox.first_prompt_at !== null,
      promptInFlight: sandbox.prompt_in_flight === 1,
      nudged: sandbox.nudged === 1,
      stoppedEarly: sandbox.stopped_early === 1,
      turnText: sandbox.turn_text !== "",
      openTodos: openEntryCount(store.todoRow(this.taskId)?.todos ?? null) > 0,
      bridgeClosedAt:
        closedAt === null
          ? "Unset"
          : workflow.now() - closedAt < RECONNECT_CEILING_MS
            ? "Recent"
            : "Old",
      queue: queued.map((prompt) => promptKindOf(prompt.text)),
      rpcs: this.rpcs.map((row) => ({ ...row })),
      steers: sortedSteers(
        store.steers().map((steer) => ({
          person: steeredPerson(queued, steer.prompt_id),
          rpc: steer.rpc_id,
          status: steer.status === "out" ? "SteerOut" : "SteerTaken",
        })),
      ),
      delivered: sortedPersons(this.delivered),
      receivedTwice: this.receivedTwice,
      artifact: store.artifact(task.job_id) !== null,
      alarms: alarms.map((alarm) => specAlarmOf(alarm) ?? ""),
      slots: {
        hello: slot(sandbox.hello_schedule),
        noProgress: slot(sandbox.no_progress_schedule),
        wall: slot(sandbox.wall_schedule),
        keepAlive: slot(sandbox.keepalive_schedule),
      },
      startsOut: Array.from({ length: sandbox.generation }, (_, index) => index + 1).filter(
        (generation) => sandboxStartInFlight(workflow, this.taskId, generation),
      ),
      sockets: this.sockets.map(({ bridge, generation, state }) => ({ bridge, generation, state })),
      bridges: this.bridges.map((bridge) => ({
        generation: bridge.generation,
        current: bridge.token === sandbox.bridge_token,
        alive: bridge.alive,
        saidHello: bridge.saidHello,
        requests: bridge.requests.map(({ id, purpose, cancelled, carries }) => ({
          id,
          purpose,
          cancelled,
          carries,
        })),
      })),
      calls: this.calls.map(projectCall),
      promptsSent: this.promptsSent,
      cancelsDelivered: this.cancelsDelivered,
      permissionsAsked: this.permissionsAsked,
      permissionsWithAnAllowOption: this.permissionsWithAnAllowOption,
      permissionsAllowed: this.permissionsAllowed,
      socketsClosed: this.socketsClosed,
      agentWakes: workflow.notes.filter((note) =>
        AGENT_WAKE_TEXTS.some((text) => note.text.includes(text)),
      ).length,
      eventsThatThrew: this.eventsThatThrew,
      lostTurns: store
        .logLines()
        .filter((row) => row.task_id === this.taskId && LOST_TURN_LINES.includes(row.line)).length,
      stopsEnded: this.stopsEnded,
      answersToOtherRequests: this.answersToOtherRequests,
    };
  }

  /** True while a bridge of `generation` runs, as the sandbox reports it. */
  bridgeRuns(generation: number): boolean {
    return this.bridges.some((bridge) => bridge.alive && bridge.generation === generation);
  }

  /**
   * Hold a sandbox start from its commit author lookup until a later step returns it. The lookup
   * goes on when the container launches. A start that fails before it launched fails its lookup
   * in an odd generation and its provider start in an even one.
   */
  holdStart(): Promise<void> {
    const { generation, bridge_token } = this.world.workflow.store.requireSandbox(this.taskId);
    const awaits = { lookup: openGate(), start: openGate() };
    awaits.start.promise.catch(() => undefined);
    this.startAwaits.set(generation, awaits);
    const start: HeldStart = {
      name: "SandboxStart",
      generation,
      token: bridge_token,
      launched: false,
    };
    this.hold({ kind: start, answer: ({ ok }) => answerStart(start, awaits, ok) });
    return awaits.lookup.promise;
  }

  /** The provider's start of `generation`, which stays out until a later step returns it. */
  heldStart(generation: number): Promise<void> {
    const awaits = this.startAwaits.get(generation);
    if (!awaits) throw new Error(`no start of ${generation} is held`);
    this.providerStartsReached.get(generation)?.();
    return awaits.start.promise;
  }

  /**
   * A D1 binding whose router writes of a branch binding stay out until a later step returns
   * them. A write that the step returns not ok throws.
   */
  holdingBranchBindings(db: Env["DB"]): Env["DB"] {
    const holdBinding = () =>
      new Promise<void>((resolve, reject) => {
        this.hold({
          kind: { name: "BranchBinding" },
          answer: ({ ok }) => (ok ? resolve() : reject(new Error("the router write failed"))),
        });
      });
    const binding: object = {
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!BRANCH_BINDING_WRITE.test(sql)) return statement;
        return {
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            if (!params.includes("code_branch")) return bound;
            return {
              run: async () => holdBinding().then(() => bound.run()),
              all: async () => holdBinding().then(() => bound.all()),
              raw: async () => holdBinding().then(() => bound.raw()),
              first: async () => holdBinding().then(() => bound.first()),
            };
          },
        };
      },
    };
    return binding as Env["DB"];
  }

  /** Hold a sandbox destroy until a later step returns it. */
  holdDestroy(): Promise<void> {
    const upTo = this.world.workflow.store.requireSandbox(this.taskId).generation;
    return new Promise<void>((resolve) => {
      this.hold({ kind: { name: "SandboxDestroy", upTo }, answer: () => resolve() });
    });
  }

  /** Hold the summarization of a long turn text until a later step returns it. */
  holdSummarization(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.hold({ kind: { name: "Summarization" }, answer: () => resolve() });
    });
  }

  private holdOutcomeCheck(): Promise<Decisions | null> {
    return new Promise<Decisions | null>((resolve) => {
      this.hold({
        kind: {
          name: "OutcomeCheck",
          promptsAtTurnEnd: this.promptsSent,
          generation: this.world.workflow.store.requireSandbox(this.taskId).generation,
        },
        answer: ({ decisions }) => resolve(decisions),
      });
    });
  }

  private hold(call: Omit<HeldCall, "id" | "state" | "step" | "alarm">): void {
    this.calls.push({
      ...call,
      id: this.nextCall++,
      state: "Out",
      step: this.stepOut,
      alarm: this.alarmOut,
    });
    this.heldArrived?.();
  }

  private watchRpcRows(): void {
    const { store } = this.world.workflow;
    const insertRpc = store.insertRpc.bind(store);
    const takeRpc = store.takeRpc.bind(store);
    const clearRpc = store.clearRpc.bind(store);
    store.insertRpc = (taskId, method, purpose) => {
      const id = insertRpc(taskId, method, purpose);
      this.rpcSerial += 1;
      this.lastRpcRow = { id, serial: this.rpcSerial };
      this.rowSerials.set(id, this.rpcSerial);
      const specPurpose = SPEC_PURPOSE[purpose];
      if (specPurpose) this.rpcs.push({ id, purpose: specPurpose });
      if (purpose === "prompt") this.promptsSent += 1;
      return id;
    };
    store.takeRpc = (id, taskId) => {
      const pending = takeRpc(id, taskId);
      if (!pending) return pending;
      this.rpcs.splice(
        this.rpcs.findIndex((row) => row.id === id),
        1,
      );
      if (this.answeredSerial !== null && this.rowSerials.get(id) !== this.answeredSerial) {
        this.answersToOtherRequests += 1;
      }
      this.rowSerials.delete(id);
      return pending;
    };
    store.clearRpc = (taskId) => {
      clearRpc(taskId);
      this.rpcs.splice(0, this.rpcs.length);
      this.rowSerials.clear();
    };
  }

  private task(): TaskRow {
    return this.world.workflow.store.requireTask(this.taskId);
  }

  private async act(step: TraceStep): Promise<void> {
    const { picks } = step;
    const { workflow } = this.world;
    switch (step.action) {
      case "personPrompts":
        return this.runStep(() =>
          instructTask(workflow, this.task(), `${PERSON_TEXT} ${this.personPrompts++}`),
        );
      case "agentPausesAuthor":
        return this.runStep(() => pauseTask(workflow, this.task(), []));
      case "agentResumesAuthor":
        return this.runStep(() => resumeTask(workflow, this.task(), { text: "", answering: [] }));
      case "personStops":
        return this.stop();
      case "agentCancelsJob":
        return this.runStep(async () => {
          const { cancel_job } = startTools(workflow);
          await cancel_job.execute(
            { job_id: this.task().job_id, reason: "a person asked" },
            TOOL_CALL,
          );
        });
      case "alarmFires":
        return this.fireAlarm(required(picks.alarmIndex));
      case "timePasses":
        this.clock += PAST_THE_RECONNECT_CEILING_MS;
        setSystemTime(new Date(this.clock));
        return;
      case "durableObjectRestarts":
        return this.restartDurableObject();
      case "branchBindingReturns":
        return this.returnCall(this.callOf(required(picks.callId)), {
          ok: required(picks.ok),
          decisions: new FakeDecisions(ANSWERS),
        });
      case "sandboxStartLaunchesBridge":
        return this.launchAndRunToTheProviderStart(this.callOf(required(picks.callId)));
      case "sandboxStartReturns":
        return this.returnStart(required(picks.callId), required(picks.ok));
      case "sandboxStartFailsAtOnce":
        return this.returnCall(this.callOf(required(picks.callId)), {
          ok: true,
          decisions: new FakeDecisions(ANSWERS),
        });
      case "sandboxDestroyReturns":
        return this.returnDestroy(required(picks.callId));
      case "outcomeCheckReturns":
        return this.returnOutcomeCheck(required(picks.callId), required(picks.outcome));
      case "summarizationReturns":
        return this.returnCall(this.callOf(required(picks.callId)), {
          ok: true,
          decisions: new FakeDecisions(ANSWERS),
        });
      case "bridgeDials":
        return this.dial(required(picks.bridge));
      case "socketDrops":
        this.socketAt(required(picks.index)).state = "BridgeGone";
        return;
      case "bridgeDies":
        this.endBridge(required(picks.bridge));
        return;
      case "socketCloseLands":
        return this.landClose(required(picks.index));
      case "harnessAnswers":
        return this.answer(
          required(picks.bridge),
          required(picks.finished),
          required(picks.endsWithText),
        );
      case "harnessAnswersASteer":
        return this.answerSteer(required(picks.bridge), required(picks.beforeItsTurnStarts));
      case "harnessRefuses":
        return this.refuse(required(picks.bridge));
      case "harnessShowsProgress":
      case "theHarnessListsItsTodos":
        this.bridgeAt(required(picks.bridge)).turnShowedProgress = true;
        return this.update(required(picks.bridge), this.progressOf(required(picks.report)));
      case "harnessWritesThePage": {
        const author = this.world.authors[0]!;
        const link = `I wrote ${this.world.artifactUrlOf(author)} for this.`;
        return this.update(required(picks.bridge), {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${link} ${TURN_TEXT}` },
        });
      }
      case "harnessAsksPermission":
        return this.askPermission(required(picks.bridge), required(picks.offersAllow));
      case "harnessExits":
      case "theHarnessExitsUnderAnIdleAuthor":
        return this.exit(required(picks.bridge));
      default:
        throw new Error(`no replay action for spec action ${step.action}`);
    }
  }

  private async fireAlarm(alarmIndex: number): Promise<void> {
    const { workflow } = this.world;
    const alarm = workflow.alarms.filter((armed) => specAlarmOf(armed) !== null)[alarmIndex];
    if (!alarm) throw new Error(`no alarm ${alarmIndex} is armed`);
    await workflow.cancelAlarm(alarm.id);
    await this.runStep(() => {
      switch (alarm.method) {
        case "provision":
          return provision(workflow, (alarm.payload as TaskAlarm).task_id);
        case "onHelloTimeout":
          return onHelloTimeout(workflow, alarm.payload as GenerationAlarm);
        case "onNoProgress":
          return onNoProgress(workflow, alarm.payload as GenerationAlarm);
        case "onWallClock":
          return onWallClock(workflow, alarm.payload as TaskAlarm);
        case "keepSandboxAlive":
          return keepSandboxAlive(workflow, alarm.payload as GenerationAlarm);
        case "retryQueue":
          return retryQueue(workflow, alarm.payload as GenerationAlarm);
        case "settleIdleAuthor":
          return settleIdleAuthor(workflow, alarm.payload as GenerationAlarm);
        case "onBridgeLost":
          return onBridgeLost(workflow, alarm.payload as GenerationAlarm);
        default:
          throw new Error(`the replay does not fire ${alarm.method}`);
      }
    }, alarm);
  }

  private async restartDurableObject(): Promise<void> {
    const kept: HeldCall[] = [];
    const rescheduled: FakeAlarm[] = [];
    for (const call of this.calls) {
      if (call.state !== "Out") {
        kept.push(call);
        continue;
      }
      if (call.alarm) rescheduled.push(call.alarm);
      if (call.kind.name === "SandboxDestroy") this.containerGoes(call.kind.upTo);
      else if (call.kind.name === "SandboxStart" && !call.kind.launched)
        kept.push({ ...call, state: "Dropped", alarm: null });
    }
    this.calls = kept;
    this.world.workflow.alarms.push(...rescheduled);
    await this.world.restart();
  }

  private callOf(callId: number): HeldCall {
    const call = this.calls.find((held) => held.id === callId);
    if (!call) throw new Error(`no call ${callId} is held`);
    return call;
  }

  private withoutCall(call: HeldCall): void {
    this.calls = this.calls.filter((held) => held !== call);
  }

  private launch(call: HeldCall): void {
    if (call.kind.name !== "SandboxStart" || call.kind.launched) return;
    call.kind.launched = true;
    if (call.state === "Dropped") this.withoutCall(call);
    else this.startAwaits.get(call.kind.generation)?.lookup.resolve();
    this.bridges.push({
      generation: call.kind.generation,
      token: call.kind.token,
      alive: true,
      saidHello: false,
      requests: [],
      received: new Set(),
      inTurn: new Set(),
      turnShowedProgress: false,
    });
  }

  /**
   * Launch the container of a held start, and run the start on until it waits on the provider's
   * start, holds another call, or ends, so later steps do not run its rest.
   */
  private async launchAndRunToTheProviderStart(call: HeldCall): Promise<void> {
    if (call.kind.name !== "SandboxStart" || call.kind.launched || call.state === "Dropped") {
      return this.launch(call);
    }
    const { generation } = call.kind;
    const providerStartReached = new Promise<void>((resolve) => {
      this.providerStartsReached.set(generation, resolve);
    });
    await this.runStep(async () => {
      this.launch(call);
      await Promise.race([call.step, providerStartReached]);
    }, call.alarm);
    this.providerStartsReached.delete(generation);
  }

  private returnStart(callId: number, ok: boolean): Promise<void> {
    const call = this.callOf(callId);
    if (ok) this.launch(call);
    return this.returnCall(call, { ok, decisions: new FakeDecisions(ANSWERS) });
  }

  private returnDestroy(callId: number): Promise<void> {
    const call = this.callOf(callId);
    if (call.kind.name === "SandboxDestroy") this.containerGoes(call.kind.upTo);
    return this.returnCall(call, { ok: true, decisions: new FakeDecisions(ANSWERS) });
  }

  private returnOutcomeCheck(callId: number, outcome: Outcome): Promise<void> {
    const decisions = new FakeDecisions(ANSWERS, {
      outcome: { option: OUTCOME_OPTIONS[outcome], probability: 0.9 },
    });
    return this.returnCall(this.callOf(callId), { ok: true, decisions });
  }

  private async returnCall(
    call: HeldCall,
    answer: { ok: boolean; decisions: Decisions },
  ): Promise<void> {
    if (call.state !== "Out") throw new Error("the call is not out");
    this.withoutCall(call);
    const rest = call.step;
    await this.runStep(async () => {
      call.answer(answer);
      await rest;
    }, call.alarm);
  }

  private containerGoes(upTo: number): void {
    this.bridges.forEach((bridge, index) => {
      if (bridge.alive && bridge.generation <= upTo) this.endBridge(index);
    });
  }

  private endBridge(index: number): void {
    const bridge = this.bridgeAt(index);
    bridge.alive = false;
    for (const socket of this.sockets) {
      if (socket.bridge !== index) continue;
      if (socket.state === "Connected") socket.state = "BridgeGone";
      if (socket.state === "ClosingReplaced" || socket.state === "ClosingContainer") {
        socket.state = "ClosingBridgeGone";
      }
    }
  }

  private async dial(index: number): Promise<void> {
    const bridge = this.bridgeAt(index);
    const { workflow } = this.world;
    const dialRequest = new Request(
      bridgeDialUrl(
        "https://artfct.test",
        workflow.store.requireWorkflowRow().workflow_id,
        this.taskId,
      ),
      { headers: bridgeTokenHeaders(bridge.token) },
    );
    const sandbox = authorizeBridge(workflow.store, dialRequest);
    if (!sandbox) {
      bridge.alive = false;
      return;
    }
    const fake = fakeConnection(this.taskId, sandbox.generation);
    const socket: ReplaySocket = {
      bridge: index,
      generation: sandbox.generation,
      state: "Connected",
      fake,
      read: 0,
      serials: new Map(),
    };
    const send = fake.connection.send.bind(fake.connection);
    fake.connection.send = (data) => {
      send(data);
      const frame = fake.sent.length - 1;
      const message = parseMessage(fake.sent[frame]!);
      const row = this.lastRpcRow;
      if (message && isRequest(message) && Number(message.id) === row?.id) {
        socket.serials.set(frame, row.serial);
      }
    };
    const recordClose = fake.connection.close.bind(fake.connection);
    fake.connection.close = (code?: number, reason?: string) => {
      recordClose(code, reason);
      this.orchestratorCloses(socket, code ?? 1005);
    };
    workflow.sockets.push(fake.connection);
    this.sockets.push(socket);
    acceptBridge(workflow, fake.connection, sandbox);
    socket.generation = (fake.connection.state as ConnectionState).generation;
    const hello: BridgeHelloParams = {
      fresh: !bridge.saidHello,
      harness: sandbox.harness,
      generation: bridge.generation,
    };
    bridge.saidHello = true;
    await this.runStep(() => this.deliver(socket, jsonRpcNotification(BridgeMethods.hello, hello)));
  }

  private orchestratorCloses(socket: ReplaySocket, code: number): void {
    const { workflow } = this.world;
    workflow.sockets = workflow.sockets.filter(
      (connection) => connection !== socket.fake.connection,
    );
    if (socket.state === "Connected") {
      this.socketsClosed += 1;
      socket.state = code === 1000 ? "ClosingContainer" : "ClosingReplaced";
    } else if (socket.state === "BridgeGone") {
      this.socketsClosed += 1;
      socket.state = "ClosingBridgeGone";
    }
  }

  private async landClose(index: number): Promise<void> {
    const socket = this.socketAt(index);
    this.sockets = this.sockets.filter((other) => other !== socket);
    const { workflow } = this.world;
    workflow.sockets = workflow.sockets.filter(
      (connection) => connection !== socket.fake.connection,
    );
    if (socket.state === "ClosingContainer" && this.bridgeAt(socket.bridge).alive) {
      this.endBridge(socket.bridge);
    }
    const state = socket.fake.connection.state as ConnectionState;
    await this.runStep(() => onBridgeClosed(this.world.workflow, state));
  }

  private async answer(
    index: number,
    finished: FinishedStop,
    endsWithText: boolean,
  ): Promise<void> {
    const bridge = this.bridgeAt(index);
    const socket = this.connectedSocketOf(index);
    const request = bridge.requests.find((held) => held.purpose !== "Steer");
    if (!request) throw new Error(`bridge ${index} holds no request besides steers`);
    bridge.requests = bridge.requests.filter((held) => held !== request);
    if (request.purpose === "Prompt") this.endHarnessTurn(bridge, request.cancelled);
    const endsOnItsOwn =
      request.purpose === "Prompt" && !request.cancelled && finished === "EndTurn";
    if (endsOnItsOwn && endsWithText) {
      await this.runStep(() =>
        this.deliverUpdate(socket, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: TURN_TEXT },
        }),
      );
    }
    const result = this.resultOf(request, finished);
    await this.answerRequest(request, () =>
      this.deliver(socket, jsonRpcResponse(request.id, result)),
    );
  }

  /**
   * The harness answers its oldest steer. A prompt before it runs a turn, which takes the steer.
   * Without one the harness answers that it needs a prompt. It answers so too when the turn has
   * not reported progress and has not started yet.
   */
  private async answerSteer(index: number, beforeItsTurnStarts: boolean): Promise<void> {
    const bridge = this.bridgeAt(index);
    const socket = this.connectedSocketOf(index);
    const at = bridge.requests.findIndex((held) => held.purpose === "Steer");
    const steer = bridge.requests[at];
    if (!steer) throw new Error(`bridge ${index} holds no steer`);
    const intoATurn = bridge.requests.slice(0, at).some((held) => held.purpose === "Prompt");
    const notStarted = beforeItsTurnStarts && !bridge.turnShowedProgress;
    const injected = intoATurn && !notStarted;
    bridge.requests.splice(at, 1);
    if (injected) this.receivePerson(bridge, steer.carries);
    const result = injected
      ? { outcome: "injected" }
      : { outcome: "promptRequired", reason: "noRunningTurn" };
    await this.answerRequest(steer, () => this.deliver(socket, jsonRpcResponse(steer.id, result)));
  }

  /** The harness session of `bridge` receives a person prompt, and counts one it already had. */
  private receivePerson(bridge: ReplayBridge, person: number | null): void {
    if (person === null) return;
    if (bridge.received.has(person)) this.receivedTwice += 1;
    bridge.received.add(person);
    bridge.inTurn.add(person);
  }

  /**
   * The harness turn of `bridge` ends. A turn that ended without a cancel delivered its person
   * prompts. A cancelled one did not, so its session may receive them again.
   */
  private endHarnessTurn(bridge: ReplayBridge, cancelled: boolean): void {
    for (const person of bridge.inTurn) {
      if (cancelled) bridge.received.delete(person);
      else this.delivered.add(person);
    }
    bridge.inTurn.clear();
    bridge.turnShowedProgress = false;
  }

  /** Deliver the answer to one request, so a taken rpc row is checked against the row behind it. */
  private async answerRequest(request: BridgeRequest, deliver: () => Promise<void>): Promise<void> {
    this.answeredSerial = request.serial;
    try {
      await this.runStep(deliver);
    } finally {
      this.answeredSerial = null;
    }
  }

  /** A person presses Stop. It ends a turn when the author was at work and its generation ends. */
  private async stop(): Promise<void> {
    const { workflow } = this.world;
    const atWork = taskAtWork(workflow, this.task());
    const { generation } = workflow.store.requireSandbox(this.taskId);
    await this.runStep(() => stopAuthor(workflow, this.task()));
    const ended = workflow.store.requireSandbox(this.taskId).generation > generation;
    if (atWork && ended) this.stopsEnded += 1;
  }

  private resultOf(request: BridgeRequest, finished: FinishedStop): unknown {
    switch (request.purpose) {
      case "Initialize": {
        const initialized: InitializeResponse = { protocolVersion: 1 };
        return initialized;
      }
      case "SessionNew": {
        const session: NewSessionResponse = {
          sessionId: `session-${request.id}`,
          configOptions: [effortOption(HELD_EFFORT)],
        };
        return session;
      }
      case "SetEffort": {
        const set: SetSessionConfigOptionResponse = { configOptions: [effortOption(ASKED_EFFORT)] };
        return set;
      }
      case "Prompt": {
        const ended: PromptResponse = {
          stopReason: request.cancelled ? "cancelled" : STOP_REASONS[finished],
        };
        return ended;
      }
      case "Steer":
        throw new Error("the harness answers a steer apart from its turn");
      default: {
        const unreachable: never = request.purpose;
        throw new Error(`unhandled purpose ${String(unreachable)}`);
      }
    }
  }

  private async refuse(index: number): Promise<void> {
    const bridge = this.bridgeAt(index);
    const socket = this.connectedSocketOf(index);
    const request = bridge.requests.shift();
    if (!request) throw new Error(`bridge ${index} holds no request`);
    if (request.purpose === "Prompt") this.endHarnessTurn(bridge, false);
    await this.answerRequest(request, () =>
      this.deliver(socket, jsonRpcErrorResponse(request.id, INTERNAL_ERROR, "the harness failed")),
    );
  }

  private progressOf(report: ProgressReport): SessionUpdate {
    switch (report) {
      case "ToolCall":
        return {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${this.permissionSeq++}`,
          title: "Edit the design",
          kind: "edit",
        };
      case "OpenTodoList":
        return { sessionUpdate: "plan", entries: OPEN_TODOS };
      case "FinishedTodoList":
        return { sessionUpdate: "plan", entries: FINISHED_TODOS };
      default: {
        const unreachable: never = report;
        throw new Error(`unhandled report ${String(unreachable)}`);
      }
    }
  }

  private update(index: number, update: SessionUpdate): Promise<void> {
    const socket = this.connectedSocketOf(index);
    return this.runStep(() => this.deliverUpdate(socket, update));
  }

  private deliverUpdate(socket: ReplaySocket, update: SessionUpdate): Promise<void> {
    const sessionId = this.world.workflow.store.requireSandbox(this.taskId).session_id ?? "none";
    const notice: SessionNotification = { sessionId, update };
    return this.deliver(socket, jsonRpcNotification(ClientMethods.sessionUpdate, notice));
  }

  private async askPermission(index: number, offersAllow: boolean): Promise<void> {
    const socket = this.connectedSocketOf(index);
    const served = this.served(socket);
    this.permissionSeq += 1;
    const id = `permission-${this.permissionSeq}`;
    const params: RequestPermissionRequest = {
      sessionId: this.world.workflow.store.requireSandbox(this.taskId).session_id ?? "none",
      toolCall: { toolCallId: id, title: "Write the page" },
      options: offersAllow
        ? [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
        : [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
    };
    const before = socket.fake.sent.length;
    await this.runStep(() =>
      this.deliver(socket, jsonRpcRequest(id, ClientMethods.sessionRequestPermission, params)),
    );
    if (served) this.permissionsAsked += 1;
    if (served && offersAllow) this.permissionsWithAnAllowOption += 1;
    const allowed = socket.fake.sent.slice(before).some((frame) => {
      const message = parseMessage(frame);
      if (!message || !isResponse(message) || message.id !== id) return false;
      const outcome = (
        message as { result?: { outcome?: { outcome?: string; optionId?: string } } }
      ).result?.outcome;
      return outcome?.outcome === "selected" && outcome.optionId === "allow";
    });
    if (allowed) this.permissionsAllowed += 1;
    socket.read = Math.max(socket.read, before);
  }

  private async exit(index: number): Promise<void> {
    const socket = this.connectedSocketOf(index);
    const exit: BridgeExitParams = { code: 1, signal: null };
    await this.runStep(() => this.deliver(socket, jsonRpcNotification(BridgeMethods.exit, exit)));
    this.endBridge(index);
  }

  private served(socket: ReplaySocket): boolean {
    return socket.generation === this.world.workflow.store.requireSandbox(this.taskId).generation;
  }

  private deliver(socket: ReplaySocket, message: JsonRpcMessage): Promise<void> {
    return onBridgeMessage(this.world.workflow, socket.fake.connection, JSON.stringify(message));
  }

  /** Every bridge reads the frames the orchestrator wrote to its socket while it held it open. */
  private readSentFrames(): void {
    for (const socket of this.sockets) {
      const first = socket.read;
      const frames = socket.fake.sent.slice(first);
      socket.read = socket.fake.sent.length;
      const bridge = this.bridgeAt(socket.bridge);
      const reads =
        bridge.alive && socket.state !== "BridgeGone" && socket.state !== "ClosingBridgeGone";
      if (!reads) continue;
      frames.forEach((frame, offset) =>
        this.readFrame(bridge, frame, socket.serials.get(first + offset)),
      );
    }
  }

  private readFrame(bridge: ReplayBridge, frame: string, serial: number | undefined): void {
    const message = parseMessage(frame);
    if (!message) return;
    if (isRequest(message)) {
      const purpose = PURPOSE_OF_METHOD[message.method];
      if (!purpose) return;
      if (serial === undefined)
        throw new Error(`request ${message.id} went out without an rpc row`);
      const carries = personOf(JSON.stringify(message.params));
      bridge.requests.push({ id: Number(message.id), serial, purpose, cancelled: false, carries });
      if (purpose === "Prompt") this.receivePerson(bridge, carries);
      return;
    }
    if (isNotification(message) && message.method === AgentMethods.sessionCancel) {
      this.cancelsDelivered += 1;
      const head = bridge.requests.find((held) => held.purpose !== "Steer");
      if (head?.purpose === "Prompt") head.cancelled = true;
    }
  }

  private bridgeAt(index: number): ReplayBridge {
    const bridge = this.bridges[index];
    if (!bridge) throw new Error(`no bridge ${index} was launched`);
    return bridge;
  }

  private socketAt(index: number): ReplaySocket {
    const socket = this.sockets[index];
    if (!socket) throw new Error(`no socket ${index} is open`);
    return socket;
  }

  private connectedSocketOf(index: number): ReplaySocket {
    const socket = this.sockets.find((open) => open.bridge === index && open.state === "Connected");
    if (!socket) throw new Error(`bridge ${index} holds no connected socket`);
    return socket;
  }

  /**
   * Run a step until it ends or a call it makes is held. A step that throws ends there, as the
   * Durable Object event would. A call held while an alarm's handler runs carries that alarm.
   */
  private async runStep(
    step: () => Promise<unknown>,
    alarm: FakeAlarm | null = null,
  ): Promise<void> {
    this.alarmOut = alarm;
    const held = new Promise<"held">((resolve) => {
      this.heldArrived = () => resolve("held");
    });
    const started: { running: Promise<unknown> | null } = { running: null };
    this.stepOut = Promise.resolve().then(() => started.running);
    this.stepOut.catch(() => undefined);
    const running = step();
    started.running = running;
    const ended = running.then(
      () => "ended" as const,
      () => "threw" as const,
    );
    const outcome = await Promise.race([held, ended]);
    if (outcome === "threw") this.eventsThatThrew += 1;
    this.heldArrived = null;
    this.stepOut = null;
    this.alarmOut = null;
  }
}

function openGate(): Gate {
  const settlers: Pick<Gate, "resolve" | "reject">[] = [];
  const promise = new Promise<void>((resolve, reject) => {
    settlers.push({ resolve, reject });
  });
  const [settle] = settlers;
  if (!settle) throw new Error("the promise executor did not run");
  return { promise, ...settle };
}

function answerStart(start: HeldStart, awaits: StartAwaits, ok: boolean): void {
  if (!ok && !start.launched && start.generation % 2 === 1) {
    awaits.lookup.reject(new Error("the commit author lookup failed"));
    return;
  }
  awaits.lookup.resolve();
  if (ok) awaits.start.resolve();
  else awaits.start.reject(new Error("the container did not come up"));
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the spec action is missing a pick");
  return value;
}

function projectCall(call: HeldCall): SpecCall {
  switch (call.kind.name) {
    case "BranchBinding":
      return { id: call.id, kind: "BranchBinding", state: call.state };
    case "SandboxStart":
      return {
        id: call.id,
        kind: "SandboxStart",
        generation: call.kind.generation,
        launched: call.kind.launched,
        state: call.state,
      };
    case "SandboxDestroy":
      return { id: call.id, kind: "SandboxDestroy", upTo: call.kind.upTo, state: call.state };
    case "OutcomeCheck":
      return {
        id: call.id,
        kind: "OutcomeCheck",
        promptsAtTurnEnd: call.kind.promptsAtTurnEnd,
        generation: call.kind.generation,
        state: call.state,
      };
    case "Summarization":
      return { id: call.id, kind: "Summarization", state: call.state };
    default: {
      const unreachable: never = call.kind;
      throw new Error(`unhandled call ${String(unreachable)}`);
    }
  }
}

function specAlarmOf(alarm: FakeAlarm): string | null {
  const generation = (alarm.payload as Partial<GenerationAlarm>).generation;
  switch (alarm.method) {
    case "provision":
      return "Provision";
    case "onWallClock":
      return "WallClock";
    case "onHelloTimeout":
      return `HelloTimeout(${generation})`;
    case "onNoProgress":
      return `NoProgress(${generation})`;
    case "keepSandboxAlive":
      return `KeepAlive(${generation})`;
    case "retryQueue":
      return `RetryQueue(${generation})`;
    case "settleIdleAuthor":
      return `SettleIdleAuthor(${generation})`;
    case "onBridgeLost":
      return `BridgeLost(${generation})`;
    default:
      return null;
  }
}

function steeredPerson(queued: { id: number; text: string }[], promptId: number): number {
  const person = personOf(queued.find((prompt) => prompt.id === promptId)?.text ?? "");
  if (person === null) throw new Error(`steered prompt ${promptId} is not a queued person prompt`);
  return person;
}

/** Which of the person's prompts `text` carries, if any. */
function personOf(text: string): number | null {
  const match = PERSON_PROMPT.exec(text);
  return match ? Number(match[1]) : null;
}

function promptKindOf(promptText: string): SpecPrompt {
  const person = personOf(promptText);
  if (person !== null) return personPromptKind(person);
  switch (promptText) {
    case CONTINUE_TEXT:
      return "ContinuePrompt";
    case NUDGE_TEXT:
      return "NudgePrompt";
    case GAVE_UP_RESTART_TEXT:
      return "GaveUpWake";
    case LOST_SANDBOX_TEXT:
      return "LostSandboxWake";
    default:
      return "FirstPrompt";
  }
}
