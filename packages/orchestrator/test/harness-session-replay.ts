import { setSystemTime } from "bun:test";
import type {
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  SetSessionConfigOptionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
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
import type { SandboxRef, SandboxStartSpec } from "../src/sandbox/spec";
import { pauseTask, resumeTask, stopAuthor } from "../src/workflow/inbound/controls";
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
import { promptTask, retryQueue } from "../src/workflow/task/harness/prompt-queue";
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
import { fakeConnection, type FakeAlarm, type FakeSocket } from "./fake-runtime";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfText, itfVariant } from "./itf";
import { FakeSandboxProvider } from "./fake-sandbox";
import { InterleavedDecisions } from "./interleaved-decisions";
import { quintTraces } from "./quint-traces";
import { WorkflowWorld, type WorldSetup } from "./workflow-world";

/** The setup modules of the harness session spec, and whether the stage of each asks for an effort. */
export const SPEC_SETUPS = {
  harnessDefaultEffort: false,
  stageAsksForEffort: true,
  agentPausesRunningTurns: false,
} as const satisfies Record<string, boolean>;

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
const RPC_PURPOSES = ["Initialize", "SessionNew", "SetEffort", "Prompt"] as const;
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

type SpecStatus = (typeof TASK_STATUSES)[number];
type PromptKind = (typeof PROMPT_KINDS)[number];
type SpecPurpose = (typeof RPC_PURPOSES)[number];
type SocketState = (typeof SOCKET_STATES)[number];
type CallState = (typeof CALL_STATES)[number];
type Outcome = (typeof OUTCOMES)[number];
type FinishedStop = (typeof FINISHED_STOPS)[number];

/** A request a bridge passed to its harness, as the spec sees it. */
type SpecRequest = { id: number; purpose: SpecPurpose; cancelled: boolean };

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
  | { id: number; kind: "SandboxStart"; generation: number; launched: boolean; state: CallState }
  | { id: number; kind: "SandboxDestroy"; upTo: number; state: CallState }
  | {
      id: number;
      kind: "OutcomeCheck";
      promptsAtTurnEnd: number;
      generation: number;
      state: CallState;
    };

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
  promptInFlight: boolean;
  nudged: boolean;
  stoppedEarly: boolean;
  bridgeClosedAt: (typeof STAMPS)[number];
  queue: PromptKind[];
  rpcs: { id: number; purpose: SpecPurpose }[];
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
  permissionsAllowed: number;
  socketsClosed: number;
  eventsThatThrew: number;
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
    promptInFlight: itfBool(itfField(world, "promptInFlight")),
    nudged: itfBool(itfField(world, "nudged")),
    stoppedEarly: itfBool(itfField(world, "stoppedEarly")),
    bridgeClosedAt: itfOneOf(tagOf(itfField(world, "bridgeClosedAt")), STAMPS),
    queue: itfList(itfField(world, "queue")).map((kind) => itfOneOf(tagOf(kind), PROMPT_KINDS)),
    rpcs: itfList(itfField(world, "rpcs")).map((row) => ({
      id: itfInt(itfField(row, "id")),
      purpose: itfOneOf(tagOf(itfField(row, "purpose")), RPC_PURPOSES),
    })),
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
      })),
    })),
    calls: itfList(itfField(world, "calls")).map(specCall),
    promptsSent: itfInt(itfField(world, "promptsSent")),
    cancelsDelivered: itfInt(itfField(world, "cancelsDelivered")),
    permissionsAsked: itfInt(itfField(world, "permissionsAsked")),
    permissionsAllowed: itfInt(itfField(world, "permissionsAllowed")),
    socketsClosed: itfInt(itfField(world, "socketsClosed")),
    eventsThatThrew: itfInt(itfField(world, "eventsThatThrew")),
  };
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
    default:
      throw new Error(`the trace has a call ${kind.tag}`);
  }
}

function tagOf(value: unknown): string {
  return itfVariant(value)!.tag;
}

/** One request a bridge passed to its harness. */
type BridgeRequest = { id: number; purpose: SpecPurpose; cancelled: boolean };

/** One bridge process and its harness, as the replay runs it. */
type ReplayBridge = {
  generation: number;
  token: string;
  alive: boolean;
  saidHello: boolean;
  requests: BridgeRequest[];
};

/** One socket the replay dialed, with the frames of it the bridge already read. */
type ReplaySocket = {
  bridge: number;
  generation: number;
  state: SocketState;
  fake: FakeSocket;
  read: number;
};

/** One call the replay holds, with the step that waits on it. */
type HeldCall = {
  id: number;
  kind:
    | { name: "SandboxStart"; generation: number; token: string; launched: boolean }
    | { name: "SandboxDestroy"; upTo: number }
    | { name: "OutcomeCheck"; promptsAtTurnEnd: number; generation: number };
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
    await this.replay.holdStart(spec);
  }

  override async destroy(sandbox: SandboxRef): Promise<void> {
    await super.destroy(sandbox);
    await this.replay.holdDestroy();
  }

  override async bridgeRunning(_sandbox: SandboxRef, generation: number): Promise<boolean> {
    return this.replay.bridgeRuns(generation);
  }
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const PERSON_TEXT = "Cover the error path too.";
const CONTINUE_TEXT = "Continue where you left off.";
const TURN_TEXT = "I wrote the design section by section.";
const HELD_EFFORT = "low";
const ASKED_EFFORT = "high";
const INTERNAL_ERROR = -32603;

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
};

const SPEC_PURPOSE: Record<RpcPurpose, SpecPurpose | null> = {
  initialize: "Initialize",
  session_new: "SessionNew",
  set_effort: "SetEffort",
  prompt: "Prompt",
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

const WORLD_SETUP: WorldSetup = {
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
 * The sandbox start, the sandbox destroy and the turn outcome question stay out until a later
 * spec step returns them.
 */
export class HarnessSessionReplay {
  private calls: HeldCall[] = [];
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
  private permissionsAllowed = 0;
  private socketsClosed = 0;
  private eventsThatThrew = 0;
  private permissionSeq = 0;
  private clock = REPLAY_START;

  private constructor(
    readonly world: WorkflowWorld,
    private readonly taskId: string,
  ) {}

  /** A world with one queued harness author, and a stage that asks for an effort when `setup` says so. */
  static async open(setup: SpecSetup): Promise<HarnessSessionReplay> {
    setSystemTime(new Date(REPLAY_START));
    const world = await WorkflowWorld.open(WORLD_SETUP);
    const author = world.authors[0];
    if (!author) throw new Error("the world has no author");
    const replay = new HarnessSessionReplay(world, author.taskId);
    const { workflow } = world;
    workflow.sandboxProvider = new HoldingSandboxProvider(replay);
    if (SPEC_SETUPS[setup]) {
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
    this.world.workflow.gatewayInstance = new FakeGateway({
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
    return {
      status: SPEC_STATUS[task.status],
      restarts: task.restarts,
      paused: task.paused_at !== null,
      generation: sandbox.generation,
      session: sandbox.session_id !== null,
      promptInFlight: sandbox.prompt_in_flight === 1,
      nudged: sandbox.nudged === 1,
      stoppedEarly: sandbox.stopped_early === 1,
      bridgeClosedAt:
        closedAt === null
          ? "Unset"
          : workflow.now() - closedAt < RECONNECT_CEILING_MS
            ? "Recent"
            : "Old",
      queue: store
        .queue()
        .filter((prompt) => prompt.task_id === this.taskId)
        .map((prompt) => promptKindOf(prompt.text)),
      rpcs: this.rpcs.map((row) => ({ ...row })),
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
        requests: bridge.requests.map((request) => ({ ...request })),
      })),
      calls: this.calls.map(projectCall),
      promptsSent: this.promptsSent,
      cancelsDelivered: this.cancelsDelivered,
      permissionsAsked: this.permissionsAsked,
      permissionsAllowed: this.permissionsAllowed,
      socketsClosed: this.socketsClosed,
      eventsThatThrew: this.eventsThatThrew,
    };
  }

  /** True while a bridge of `generation` runs, as the sandbox reports it. */
  bridgeRuns(generation: number): boolean {
    return this.bridges.some((bridge) => bridge.alive && bridge.generation === generation);
  }

  /** Hold a sandbox start until a later step returns it. */
  holdStart(spec: SandboxStartSpec): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.hold({
        kind: {
          name: "SandboxStart",
          generation: spec.generation,
          token: spec.token,
          launched: false,
        },
        answer: ({ ok }) => (ok ? resolve() : reject(new Error("the container did not come up"))),
      });
    });
  }

  /** Hold a sandbox destroy until a later step returns it. */
  holdDestroy(): Promise<void> {
    const upTo = this.world.workflow.store.requireSandbox(this.taskId).generation;
    return new Promise<void>((resolve) => {
      this.hold({ kind: { name: "SandboxDestroy", upTo }, answer: () => resolve() });
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
      const specPurpose = SPEC_PURPOSE[purpose];
      if (specPurpose) this.rpcs.push({ id, purpose: specPurpose });
      if (purpose === "prompt") this.promptsSent += 1;
      return id;
    };
    store.takeRpc = (id, taskId) => {
      const pending = takeRpc(id, taskId);
      if (pending)
        this.rpcs.splice(
          this.rpcs.findIndex((row) => row.id === id),
          1,
        );
      return pending;
    };
    store.clearRpc = (taskId) => {
      clearRpc(taskId);
      this.rpcs.splice(0, this.rpcs.length);
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
        return this.runStep(() => promptTask(this.world.workflow, this.task(), PERSON_TEXT));
      case "agentPausesAuthor":
        return this.runStep(() => pauseTask(workflow, this.task(), []));
      case "agentResumesAuthor":
        return this.runStep(() => resumeTask(workflow, this.task(), { text: "", answering: [] }));
      case "personStops":
        return this.runStep(() => stopAuthor(workflow, this.task()));
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
      case "sandboxStartLaunchesBridge":
        this.launch(this.callOf(required(picks.callId)));
        return;
      case "sandboxStartReturns":
        return this.returnStart(required(picks.callId), required(picks.ok));
      case "sandboxDestroyReturns":
        return this.returnDestroy(required(picks.callId));
      case "outcomeCheckReturns":
        return this.returnOutcomeCheck(required(picks.callId), required(picks.outcome));
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
        return this.answer(required(picks.bridge), required(picks.finished));
      case "harnessRefuses":
        return this.refuse(required(picks.bridge));
      case "harnessShowsProgress":
        return this.update(required(picks.bridge), {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${this.permissionSeq++}`,
          title: "Edit the design",
          kind: "edit",
        });
      case "harnessWritesThePage": {
        const author = this.world.authors[0]!;
        return this.update(required(picks.bridge), {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `I wrote ${this.world.artifactUrlOf(author)} for this.` },
        });
      }
      case "harnessAsksPermission":
        return this.askPermission(required(picks.bridge));
      case "harnessExits":
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
    this.bridges.push({
      generation: call.kind.generation,
      token: call.kind.token,
      alive: true,
      saidHello: false,
      requests: [],
    });
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
      bridgeDialUrl("https://artfct.test", workflow.state.workflow_id, this.taskId),
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

  private async answer(index: number, finished: FinishedStop): Promise<void> {
    const bridge = this.bridgeAt(index);
    const socket = this.connectedSocketOf(index);
    const request = bridge.requests.shift();
    if (!request) throw new Error(`bridge ${index} holds no request`);
    if (request.purpose === "Prompt" && !request.cancelled && finished === "EndTurn") {
      await this.runStep(() =>
        this.deliverUpdate(socket, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: TURN_TEXT },
        }),
      );
    }
    const result = this.resultOf(request, finished);
    await this.runStep(() => this.deliver(socket, jsonRpcResponse(request.id, result)));
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
    await this.runStep(() =>
      this.deliver(socket, jsonRpcErrorResponse(request.id, INTERNAL_ERROR, "the harness failed")),
    );
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

  private async askPermission(index: number): Promise<void> {
    const socket = this.connectedSocketOf(index);
    const served = this.served(socket);
    this.permissionSeq += 1;
    const id = `permission-${this.permissionSeq}`;
    const params: RequestPermissionRequest = {
      sessionId: this.world.workflow.store.requireSandbox(this.taskId).session_id ?? "none",
      toolCall: { toolCallId: id, title: "Write the page" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    const before = socket.fake.sent.length;
    await this.runStep(() =>
      this.deliver(socket, jsonRpcRequest(id, ClientMethods.sessionRequestPermission, params)),
    );
    if (served) this.permissionsAsked += 1;
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
      const frames = socket.fake.sent.slice(socket.read);
      socket.read = socket.fake.sent.length;
      const bridge = this.bridgeAt(socket.bridge);
      const reads =
        bridge.alive && socket.state !== "BridgeGone" && socket.state !== "ClosingBridgeGone";
      if (!reads) continue;
      for (const frame of frames) this.readFrame(bridge, frame);
    }
  }

  private readFrame(bridge: ReplayBridge, frame: string): void {
    const message = parseMessage(frame);
    if (!message) return;
    if (isRequest(message)) {
      const purpose = PURPOSE_OF_METHOD[message.method];
      if (purpose) bridge.requests.push({ id: Number(message.id), purpose, cancelled: false });
      return;
    }
    if (isNotification(message) && message.method === AgentMethods.sessionCancel) {
      this.cancelsDelivered += 1;
      const head = bridge.requests[0];
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

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the spec action is missing a pick");
  return value;
}

function projectCall(call: HeldCall): SpecCall {
  switch (call.kind.name) {
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

function promptKindOf(promptText: string): PromptKind {
  switch (promptText) {
    case PERSON_TEXT:
      return "PersonPrompt";
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
