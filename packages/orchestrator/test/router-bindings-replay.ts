import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import type { Actor, InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { Delivery, RpcAck, WorkflowStatus } from "@artfct-ai/contracts/types";
import { startTools, validateInputNotInWork } from "../src/agent/tools/start/start";
import type { ArtifactTarget } from "../src/artifact/types";
import type { Env } from "../src/env";
import { deliver } from "../src/router/deliver";
import { recordArtifact } from "../src/workflow/artifact";
import { applyVerbalCommand } from "../src/workflow/inbound/controls";
import { createWorkflow, eventRefusalOf, type WorkflowStart } from "../src/workflow/inbound/events";
import { completeWorkflow, failWorkflow, type JobInput } from "../src/workflow/lifecycle";
import { isWorkflowFinished } from "../src/workflow/store/state";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import { runStartStep } from "./restart";
import { migratedD1Database, sqliteParams } from "./sqlite-d1";
import { FakeRuntime, seedTask, patchPlan, patchStagePlan } from "./fake-runtime";
import { openMemoryDb } from "./memory-db";
import { testEnv } from "./test-env";

/** The setup modules of the router bindings spec. */
export const SPEC_SETUPS = [
  "chatThread",
  "twoSessionsOnOneIssue",
  "sessionWithPullRequest",
  "baseMoveFanOut",
] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

const KEYS = ["Thread", "SessionA", "SessionB", "Issue", "Pull", "SecondPull"] as const;

type KeyName = (typeof KEYS)[number];

const PULL_KEYS = ["Pull", "SecondPull"] as const;

type PullKeyName = (typeof PULL_KEYS)[number];

const SURFACES = [
  "ThreadSurface",
  "SessionASurface",
  "SessionBSurface",
  "PullSurface",
  "BaseSurface",
] as const;

type SurfaceName = (typeof SURFACES)[number];

const EVENT_KINDS = [
  "Start",
  "StartWithoutAPerson",
  "PersonsMessage",
  "OtherEvent",
  "BaseMoved",
] as const;

type EventKindName = (typeof EVENT_KINDS)[number];

/** Work a workflow does against the router's tables: its end, a job start on the issue, or one of the two pull requests it records. */
export type WorkflowWork = "end" | "job_on_issue" | "pull_request" | "second_pull_request";

/** The statuses a workflow ends with. The spec reads each one as ended. */
const ENDED_STATUSES = ["done", "failed", "cancelled"] as const;

type EndedStatus = (typeof ENDED_STATUSES)[number];

/** What the Durable Object of one workflow knows, as the spec sees it. */
type ObjectView = {
  created: boolean;
  ended: boolean;
  hasIssueJob: boolean;
  openedPulls: PullKeyName[];
  unbound: boolean;
};

/**
 * The router's tables, the Durable Objects, and the call each delivery and workflow operation
 * waits on. Workflows are numbered in the order the router first named them.
 */
export type RouterView = {
  bindings: Partial<Record<KeyName, number>>;
  rows: Record<number, "Live" | "Ended">;
  objects: Record<number, ObjectView>;
  calls: Record<string, string>;
};

/** What a spec action picked. */
type SpecPicks = {
  surface: SurfaceName | null;
  kind: EventKindName | null;
  delivery: number | null;
  workflow: number | null;
  operation: number | null;
  pull: PullKeyName | null;
  landed: boolean | null;
};

/** One state of a trace: the action that led to it, what it picked, and the router as the spec sees it. */
export type TraceStep = { action: string; picks: SpecPicks; view: RouterView };

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces(
    {
      spec: "router-bindings",
      setup,
      count,
      steps: TRACE_STEPS,
      seed,
    },
    (trace) => traceSteps(trace),
  );
}

/** The steps of one ITF trace of the spec. */
export function traceSteps(trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const worldName = Object.keys(asRecord(state)).find((name) => name.endsWith("::world"));
    if (!worldName) throw new Error("the trace has no world");
    const picks = itfField(state, "mbt::nondetPicks");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        surface: pickedTag(picks, "surface", SURFACES),
        kind: pickedTag(picks, "kind", EVENT_KINDS),
        delivery: pickedInt(picks, "delivery"),
        workflow: pickedInt(picks, "workflow"),
        operation: pickedInt(picks, "operation"),
        pull: pickedTag(picks, "pull", PULL_KEYS),
        landed: pickedBool(picks, "landed"),
      },
      view: specView(itfField(state, worldName)),
    };
  });
}

function pickedValue(picks: unknown, name: string): unknown {
  const picked = itfVariant(itfField(picks, name, true));
  return picked?.tag === "Some" ? picked.value : null;
}

function pickedInt(picks: unknown, name: string): number | null {
  const value = pickedValue(picks, name);
  return value === null ? null : itfInt(value);
}

function pickedBool(picks: unknown, name: string): boolean | null {
  const value = pickedValue(picks, name);
  return value === null ? null : itfBool(value);
}

function pickedTag<Name extends string>(
  picks: unknown,
  name: string,
  names: readonly Name[],
): Name | null {
  const value = pickedValue(picks, name);
  return value === null ? null : itfOneOf(itfVariant(value)!.tag, names);
}

function isNewObject(object: ObjectView): boolean {
  return (
    !object.created &&
    !object.ended &&
    !object.hasIssueJob &&
    object.openedPulls.length === 0 &&
    !object.unbound
  );
}

type SpecDelivery = {
  surface: SurfaceName;
  phase: string;
  bindingsRead: number;
  index: number;
  workflow: number | null;
};

function specView(world: unknown): RouterView {
  const bindings: RouterView["bindings"] = {};
  for (const [key, workflow] of entries(itfField(world, "bindings"))) {
    bindings[itfOneOf(itfVariant(key)!.tag, KEYS)] = itfInt(workflow);
  }
  const rows: RouterView["rows"] = {};
  for (const [workflow, status] of entries(itfField(world, "rows"))) {
    rows[itfInt(workflow)] = itfVariant(status)!.tag === "Ended" ? "Ended" : "Live";
  }
  const objects: RouterView["objects"] = {};
  for (const [workflow, object] of entries(itfField(world, "objects"))) {
    const view: ObjectView = {
      created: itfBool(itfField(object, "created")),
      ended: itfBool(itfField(object, "ended")),
      hasIssueJob: itfBool(itfField(object, "hasIssueJob")),
      openedPulls: itfSet(itfField(object, "openedPulls"))
        .map((pull) => itfOneOf(itfVariant(pull)!.tag, PULL_KEYS))
        .toSorted(),
      unbound: itfBool(itfField(object, "unbound")),
    };
    if (!isNewObject(view)) objects[itfInt(workflow)] = view;
  }
  const calls: RouterView["calls"] = {};
  for (const [id, delivery] of entries(itfField(world, "deliveries"))) {
    calls[`d${itfInt(id)}`] = deliveryCall(specDelivery(delivery));
  }
  for (const [id, operation] of entries(itfField(world, "operations"))) {
    calls[`o${itfInt(id)}`] = operationCall(
      itfInt(itfField(operation, "workflow")),
      itfField(operation, "phase"),
    );
  }
  return { bindings, rows, objects, calls };
}

function specDelivery(delivery: unknown): SpecDelivery {
  const phase = itfVariant(itfField(delivery, "phase"))!;
  return {
    surface: itfOneOf(itfVariant(itfField(delivery, "surface"))!.tag, SURFACES),
    phase: phase.tag,
    bindingsRead: itfList(itfField(delivery, "found")).length,
    index: itfInt(itfField(delivery, "index")),
    workflow: phaseWorkflow(phase.tag, phase.value),
  };
}

function phaseWorkflow(tag: string, value: unknown): number | null {
  switch (tag) {
    case "ReadingPulls":
    case "Reading":
      return null;
    case "FanningOut":
    case "Restoring":
      return itfInt(itfField(value, "workflow"));
    default:
      return itfInt(value);
  }
}

const SURFACE_KEYS: Record<SurfaceName, KeyName[]> = {
  ThreadSurface: ["Thread"],
  SessionASurface: ["SessionA", "Issue"],
  SessionBSurface: ["SessionB", "Issue"],
  PullSurface: ["Pull"],
  BaseSurface: [],
};

function deliveryCall(delivery: SpecDelivery): string {
  const keys = SURFACE_KEYS[delivery.surface];
  const key = keys[delivery.index];
  switch (delivery.phase) {
    case "ReadingPulls":
      return "FindPullWorkflows";
    case "FanningOut":
      return `HandleEvent(${delivery.workflow})`;
    case "Reading":
      return `FindBinding(${keys[delivery.bindingsRead]})`;
    case "Checking":
      return `FindWorkflow(${delivery.workflow})`;
    case "Handling":
      return `HandleEvent(${delivery.workflow})`;
    case "Rebinding":
    case "Claiming":
    case "Binding":
    case "Restoring":
      return `ClaimBinding(${key})`;
    case "Inserting":
      return `InsertWorkflow(${delivery.workflow})`;
    case "Creating":
      return `CreateWorkflow(${delivery.workflow})`;
    case "Unbinding":
      return `DeleteBindings(${delivery.workflow})`;
    case "MarkingFailed":
      return `SetStatus(${delivery.workflow})`;
    default:
      throw new Error(`the trace has the delivery phase ${delivery.phase}`);
  }
}

function operationCall(workflow: number, phase: unknown): string {
  const named = itfVariant(phase)!;
  switch (named.tag) {
    case "EndWritesStatus":
      return `SetStatus(${workflow})`;
    case "EndUnbindsCodeHost":
      return `DeleteBindings(${workflow})`;
    case "JobReadsIssueBinding":
      return "FindBinding(Issue)";
    case "JobReadsBoundWorkflow":
      return `FindWorkflow(${itfInt(named.value)})`;
    case "JobBindsIssue":
      return "ClaimBinding(Issue)";
    case "PullBinds":
      return `BindWorkflow(${itfOneOf(itfVariant(named.value)!.tag, PULL_KEYS)}, ${workflow})`;
    default:
      throw new Error(`the trace has the operation phase ${named.tag}`);
  }
}

function entries(map: unknown): [unknown, unknown][] {
  return itfList(itfField(map, "#map")).map((pair) => {
    const [key, value] = itfList(pair);
    return [key, value];
  });
}

function asRecord(value: unknown): object {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the trace has ${JSON.stringify(value)}, not a record`);
  }
  return value;
}

/** One caller the replay drives: a delivery or a workflow operation, and the call it waits on. */
type Caller = {
  name: string;
  waiting: WaitingCall | null;
  stopped: (() => void) | null;
};

/** A call a caller made that has not landed. `land` runs it when the spec says it lands. */
type WaitingCall = {
  call: string;
  land: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/**
 * Holds every D1 statement and Durable Object call until the replay lets it land. Only one
 * caller runs at a time, so each call belongs to the caller that runs.
 */
class CallGate {
  private readonly callers = new Map<string, Caller>();
  private running: Caller | null = null;

  hold<Result>(call: string, land: () => Result | Promise<Result>): Promise<Result> {
    const caller = this.running;
    if (!caller) throw new Error(`${call} was made while no caller runs`);
    if (caller.waiting)
      throw new Error(`${caller.name} made ${call} while it waits on ${caller.waiting.call}`);
    return new Promise<Result>((resolve, reject) => {
      caller.waiting = {
        call,
        land,
        resolve: (value) => resolve(value as Result),
        reject,
      };
      caller.stopped?.();
    });
  }

  async start(name: string, run: () => Promise<unknown>): Promise<void> {
    const caller: Caller = { name, waiting: null, stopped: null };
    this.callers.set(name, caller);
    await this.runUntilStopped(caller, () => {
      run().then(
        () => this.finish(caller),
        () => this.finish(caller),
      );
    });
  }

  async land(name: string): Promise<void> {
    const { caller, waiting } = this.waitingOf(name);
    await this.runUntilStopped(caller, () => {
      Promise.resolve().then(waiting.land).then(waiting.resolve, waiting.reject);
    });
  }

  /**
   * Drop a caller whose instance restarted. The call it waits on lands first when `landed` is set.
   * The caller never hears back.
   */
  async drop(name: string, landed: boolean): Promise<void> {
    const { waiting } = this.waitingOf(name);
    this.callers.delete(name);
    if (landed) await waiting.land();
  }

  async fail(name: string, error: Error): Promise<void> {
    const { caller, waiting } = this.waitingOf(name);
    await this.runUntilStopped(caller, () => waiting.reject(error));
  }

  calls(): Record<string, string> {
    const calls: Record<string, string> = {};
    for (const caller of this.callers.values()) {
      if (caller.waiting) calls[caller.name] = caller.waiting.call;
    }
    return calls;
  }

  private waitingOf(name: string): { caller: Caller; waiting: WaitingCall } {
    const caller = this.callers.get(name);
    if (!caller?.waiting) throw new Error(`${name} does not wait on a call`);
    const { waiting } = caller;
    caller.waiting = null;
    return { caller, waiting };
  }

  private finish(caller: Caller): void {
    this.callers.delete(caller.name);
    caller.stopped?.();
  }

  private async runUntilStopped(caller: Caller, resume: () => void): Promise<void> {
    const stopped = new Promise<void>((done) => {
      caller.stopped = done;
    });
    this.running = caller;
    resume();
    await stopped;
    caller.stopped = null;
    this.running = null;
  }
}

const ISSUE: TrackerIssue = {
  id: "iss-1",
  identifier: "ENG-1",
  title: "Route the issue",
  url: "https://tracker.example/acme/issue/ENG-1",
  state: { type: "unstarted", name: "Todo" },
  team_id: "team-1",
  parent_id: null,
  project_id: null,
  labels: [],
  blockers: [],
};

const ISSUE_INPUT: JobInput = {
  kind: "issue",
  issue: {
    id: ISSUE.id,
    key: ISSUE.identifier,
    title: ISSUE.title,
    team_id: ISSUE.team_id,
    started: false,
  },
};

const REPO = "acme/app";

/** The pull request each pull key names, by its number in the repository. */
const PULL_NUMBERS: Record<PullKeyName, number> = { Pull: 7, SecondPull: 8 };

const PULL_WORK: Record<PullKeyName, WorkflowWork> = {
  Pull: "pull_request",
  SecondPull: "second_pull_request",
};

function pullTarget(pull: PullKeyName): ArtifactTarget {
  const number = PULL_NUMBERS[pull];
  return {
    url: `https://github.com/${REPO}/pull/${number}`,
    ref: { kind: "pull", repo: REPO, number },
  };
}

const PERSON: Actor = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

/** The spec key of each binding, by source and external id as the router stores them. */
const BINDING_KEYS: Record<string, KeyName> = {
  "chat_thread:C1:1.0": "Thread",
  "tracker_session:sess-a": "SessionA",
  "tracker_session:sess-b": "SessionB",
  [`tracker_issue:${ISSUE.id}`]: "Issue",
  [`code_pull:${REPO}#${PULL_NUMBERS.Pull}`]: "Pull",
  [`code_pull:${REPO}#${PULL_NUMBERS.SecondPull}`]: "SecondPull",
};

function trackerSession(sessionId: string): { bindings: Binding[]; reply_to: ReplyTarget } {
  return {
    bindings: [
      { source: "tracker_session", external_id: sessionId },
      { source: "tracker_issue", external_id: ISSUE.id },
    ],
    reply_to: { source: "tracker", session_id: sessionId, issue_id: ISSUE.id, team_id: "team-1" },
  };
}

const SURFACE_EVENTS: Record<SurfaceName, Pick<InboundEvent, "bindings" | "reply_to" | "pull">> = {
  ThreadSurface: {
    bindings: [{ source: "chat_thread", external_id: "C1:1.0" }],
    reply_to: { source: "chat", channel: "C1", thread: "1.0" },
  },
  SessionASurface: trackerSession("sess-a"),
  SessionBSurface: trackerSession("sess-b"),
  PullSurface: { bindings: [{ source: "code_pull", repo: REPO, number: PULL_NUMBERS.Pull }] },
  BaseSurface: { bindings: [], pull: { action: "base_moved", repo: REPO, base: "main" } },
};

const call = { toolCallId: "call-1", messages: [], context: {} };

/**
 * Replays spec traces through the router's deliveries and the workflows' own binding writes.
 * Every D1 statement and Durable Object call waits until a spec step lets it land. Each workflow
 * end takes the next ended status in turn, from the one `firstEndedStatus` picks.
 */
export class RouterBindingsReplay {
  private readonly gate = new CallGate();
  private readonly sqlite = migratedD1Database();
  private readonly runtimes = new Map<string, FakeRuntime>();
  private readonly unbound = new Set<string>();
  private readonly operationWorkflows = new Map<string, string>();
  private readonly delivered = new Map<string, Delivery>();
  private readonly workflowIds: string[] = [];
  private readonly env: Env;
  private nextDelivery = 0;
  private nextOperation = 0;
  private nextEvent = 0;
  private nextEndedStatus: number;

  constructor(firstEndedStatus = 0) {
    this.nextEndedStatus = firstEndedStatus;
    const namespace: object = {
      getByName: (name: string) => ({
        create: (workflowId: string, event: InboundEvent, endedWorkflowId: string | null) =>
          this.gate.hold(`CreateWorkflow(${this.specIdOf(name)})`, () =>
            this.createRuntime(name, { workflowId, event, endedWorkflowId }),
          ),
        handle: (event: InboundEvent) =>
          this.gate.hold(
            `HandleEvent(${this.specIdOf(name)})`,
            () => eventRefusalOf(this.runtimeOf(name), event) ?? { ok: true },
          ),
      }),
    };
    this.env = { ...testEnv(), DB: this.gatedD1(), Workflow: namespace as Env["Workflow"] };
  }

  /** Take one spec action. */
  async take(step: TraceStep): Promise<void> {
    const { picks } = step;
    switch (step.action) {
      case "eventArrives":
        await this.arrive(required(picks.surface, "surface"), required(picks.kind, "kind"));
        return;
      case "deliveryResumes":
        return this.gate.land(`d${required(picks.delivery, "delivery")}`);
      case "workflowCreateReturns":
        return this.gate.land(`d${required(picks.delivery, "delivery")}`);
      case "workflowCreateFails":
        return this.failCreate(`d${required(picks.delivery, "delivery")}`);
      case "fanOutCallFails":
        return this.gate.fail(
          `d${required(picks.delivery, "delivery")}`,
          new Error("Durable Object reset"),
        );
      case "workflowCallReturns":
        return this.gate.land(`o${required(picks.operation, "operation")}`);
      case "instanceRestartCutsTheEndStatusWrite":
        return this.restartDuringEndStatusWrite(
          `o${required(picks.operation, "operation")}`,
          required(picks.landed, "landed"),
        );
      case "workflowEnds":
        await this.startWork(required(picks.workflow, "workflow"), "end");
        return;
      case "workflowStartsAJobOnTheIssue":
        await this.startWork(required(picks.workflow, "workflow"), "job_on_issue");
        return;
      case "workflowOpensThePullRequest":
        await this.startWork(
          required(picks.workflow, "workflow"),
          PULL_WORK[required(picks.pull, "pull")],
        );
        return;
      default:
        throw new Error(`no replay for spec action ${step.action}`);
    }
  }

  /** The router and the workflows as the spec sees them. */
  project(): RouterView {
    const bindings: RouterView["bindings"] = {};
    for (const row of this.sqlite
      .query("select source, external_id, workflow_id from bindings")
      .all()) {
      const binding = bindingRow(row);
      const key = BINDING_KEYS[`${binding.source}:${binding.external_id}`];
      if (!key) throw new Error(`the router bound ${binding.source} ${binding.external_id}`);
      bindings[key] = this.specIdOf(binding.workflow_id);
    }
    const rows: RouterView["rows"] = {};
    for (const row of this.sqlite.query("select workflow_id, status from workflows").all()) {
      const workflow = workflowRow(row);
      rows[this.specIdOf(workflow.workflow_id)] = isWorkflowFinished(workflow.status)
        ? "Ended"
        : "Live";
    }
    const objects: RouterView["objects"] = {};
    for (const [name, runtime] of this.runtimes) {
      if (!runtime.store.workflowRow()) continue;
      const view: ObjectView = {
        created: true,
        ended: isWorkflowFinished(runtime.store.requireWorkflowRow().status),
        hasIssueJob: validateInputNotInWork(runtime, ISSUE_INPUT) !== null,
        openedPulls: runtime.store
          .artifacts()
          .flatMap(({ ref }) => (ref.kind === "pull" ? [pullKeyOf(ref.number)] : []))
          .toSorted(),
        unbound: this.unbound.has(name),
      };
      objects[this.specIdOf(name)] = view;
    }
    return { bindings, rows, objects, calls: this.gate.calls() };
  }

  /** Let the calls still out fail, so no caller stays open. */
  async close(): Promise<void> {
    let waiting = Object.keys(this.gate.calls());
    while (waiting.length > 0) {
      for (const name of waiting) await this.gate.fail(name, new Error("the replay closed"));
      waiting = Object.keys(this.gate.calls());
    }
  }

  /** An event arrives from a surface. Answers the name of its delivery. */
  async arrive(surface: SurfaceName, kind: EventKindName): Promise<string> {
    this.nextEvent += 1;
    const event: InboundEvent = {
      id: `evt-${this.nextEvent}`,
      ...eventKindOf(surface, kind),
      ...SURFACE_EVENTS[surface],
      links: [],
      text: "also add a test",
    };
    const name = `d${this.nextDelivery}`;
    this.nextDelivery += 1;
    await this.gate.start(name, async () => {
      this.delivered.set(name, await deliver(this.env, event, null));
    });
    return name;
  }

  /** A created workflow starts work on the router's tables. Answers the name of its operation. */
  async startWork(workflow: number, work: WorkflowWork): Promise<string> {
    switch (work) {
      case "end":
        return this.startOperation(workflow, (runtime) => this.endWorkflow(runtime));
      case "job_on_issue":
        return this.startOperation(workflow, (runtime) => this.startJobOnTheIssue(runtime));
      case "pull_request":
        return this.startOperation(workflow, (runtime) => this.openPullRequest(runtime, "Pull"));
      case "second_pull_request":
        return this.startOperation(workflow, (runtime) =>
          this.openPullRequest(runtime, "SecondPull"),
        );
      default: {
        const unreachable: never = work;
        throw new Error(`unhandled work ${String(unreachable)}`);
      }
    }
  }

  /** Land the calls of one caller until it waits on a call `stop` accepts, or it finishes. */
  async landUntil(caller: string, stop: (call: string) => boolean): Promise<void> {
    let waiting = this.gate.calls()[caller];
    while (waiting && !stop(waiting)) {
      await this.gate.land(caller);
      waiting = this.gate.calls()[caller];
    }
  }

  /** Throw from the Durable Object create a delivery waits on. */
  async failCreate(delivery: string): Promise<void> {
    await this.gate.fail(delivery, new Error("Durable Object reset"));
  }

  /** What a finished delivery answered, or undefined while it runs or after it threw. */
  deliveryOf(delivery: string): Delivery | undefined {
    return this.delivered.get(delivery);
  }

  private async startOperation(
    workflow: number,
    run: (runtime: FakeRuntime) => Promise<unknown>,
  ): Promise<string> {
    const name = this.workflowIds[workflow];
    const runtime = name ? this.runtimes.get(name) : undefined;
    if (!name || !runtime?.store.workflowRow()) {
      throw new Error(`workflow ${workflow} has no created Durable Object`);
    }
    const operation = `o${this.nextOperation}`;
    this.nextOperation += 1;
    this.operationWorkflows.set(operation, name);
    await this.gate.start(operation, () => run(runtime));
    return operation;
  }

  /**
   * The Durable Object of the workflow that `operation` ends restarts while its status write is out.
   * Every call the workflow has out is lost. The new instance runs the start step, and its alarm
   * goes on with the stored end under the same operation.
   */
  async restartDuringEndStatusWrite(operation: string, landed: boolean): Promise<void> {
    const name = this.operationWorkflows.get(operation);
    const runtime = name ? this.runtimes.get(name) : undefined;
    if (!name || !runtime) throw new Error(`${operation} is not the work of a workflow`);
    await this.gate.drop(operation, landed);
    for (const [other, workflow] of this.operationWorkflows) {
      if (other !== operation && workflow === name && this.gate.calls()[other]) {
        await this.gate.drop(other, false);
      }
    }
    const restarted = runtime.restarted();
    this.runtimes.set(name, restarted);
    await this.gate.start(operation, async () => {
      await runStartStep(restarted);
      this.unbound.add(name);
    });
  }

  private async endWorkflow(runtime: FakeRuntime): Promise<void> {
    const status = ENDED_STATUSES[this.nextEndedStatus % ENDED_STATUSES.length]!;
    this.nextEndedStatus += 1;
    await this.endWorkflowWith(runtime, status);
    this.unbound.add(runtime.store.requireWorkflowRow().workflow_id);
  }

  private async endWorkflowWith(runtime: FakeRuntime, status: EndedStatus): Promise<void> {
    switch (status) {
      case "done":
        return completeWorkflow(runtime, "the replay finishes it");
      case "failed":
        return failWorkflow(runtime, "the replay ends it");
      case "cancelled": {
        this.nextEvent += 1;
        const cancel: InboundEvent = {
          id: `evt-${this.nextEvent}`,
          kind: "control",
          control: "cancel",
          actor: PERSON,
          bindings: [],
          links: [],
          text: "",
        };
        await applyVerbalCommand(runtime, cancel);
        return;
      }
      default: {
        const unreachable: never = status;
        throw new Error(`unhandled ended status ${String(unreachable)}`);
      }
    }
  }

  private async startJobOnTheIssue(runtime: FakeRuntime): Promise<void> {
    await startTools(runtime).start_job.execute(
      { stage: "breakdown", brief: "Break the issue down.", issue: ISSUE.identifier },
      call,
    );
  }

  private async openPullRequest(runtime: FakeRuntime, pull: PullKeyName): Promise<void> {
    const author = seedTask(runtime, {
      task_id: `${runtime.store.requireWorkflowRow().workflow_id}.9`,
      job_id: `${runtime.store.requireWorkflowRow().workflow_id}-9`,
      stage: "implement",
    });
    await recordArtifact(runtime, author, pullTarget(pull));
  }

  /** The real create path. The subject is the issue, as the plan of a workflow from a thread names it. */
  private async createRuntime(name: string, start: WorkflowStart): Promise<RpcAck> {
    const runtime = this.runtimeOf(name);
    const created = await createWorkflow(runtime, start);
    if (!runtime.store.workflowRow() || runtime.store.plan()) return created;
    runtime.store.updateWorkflow({ status: "running" });
    patchPlan(runtime, {});
    patchStagePlan(runtime, { job_slots: 2 });
    if (!runtime.store.subject()) runtime.store.writeSubject({ kind: "issue", issue_id: ISSUE.id });
    return created;
  }

  /** The Durable Object of a workflow. It exists, not yet created, from the first call on it. */
  private runtimeOf(name: string): FakeRuntime {
    const known = this.runtimes.get(name);
    if (known) return known;
    const runtime = new FakeRuntime(openMemoryDb(), this.env, "uncreated");
    runtime.trackerInstance = new FakeTracker({ issues: [ISSUE] });
    this.runtimes.set(name, runtime);
    return runtime;
  }

  private specIdOf(workflowId: string): number {
    const known = this.workflowIds.indexOf(workflowId);
    if (known !== -1) return known;
    this.workflowIds.push(workflowId);
    return this.workflowIds.length - 1;
  }

  private gatedD1(): Env["DB"] {
    const statementOf = (sql: string, params: unknown[]) => {
      const named = this.statementCall(sql, params);
      const execute = <Result>(run: () => Result) =>
        this.gate.hold(named, () => {
          const result = run();
          return named === FIND_PULL_WORKFLOWS ? this.inSpecOrder(result) : result;
        });
      return {
        run: () =>
          execute(() => {
            const changes = this.sqlite.query(sql).run(...sqliteParams(params)).changes;
            return { success: true, results: [], meta: { changes } };
          }),
        all: () =>
          execute(() => ({
            success: true,
            results: this.sqlite.query(sql).all(...sqliteParams(params)),
            meta: {},
          })),
        raw: () => execute(() => this.sqlite.query(sql).values(...sqliteParams(params))),
        first: () => execute(() => this.sqlite.query(sql).get(...sqliteParams(params))),
      };
    };
    const binding: object = {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => statementOf(sql, params),
      }),
    };
    return binding as Env["DB"];
  }

  /** The fan-out reads the workflows in the order the spec hands them the event: the smallest spec id first. */
  private inSpecOrder<Result>(result: Result): Result {
    const rows = Array.isArray(result) ? result : itfList(itfField(result, "results"));
    const sorted = rows.toSorted(
      (left: object, right: object) =>
        this.specIdOf(firstText(left)) - this.specIdOf(firstText(right)),
    );
    return (Array.isArray(result) ? sorted : { ...result, results: sorted }) as Result;
  }

  /** The call a D1 statement makes, as the spec names it. A new workflow id gets the next number. */
  private statementCall(sql: string, params: unknown[]): string {
    const ids = params
      .filter((param): param is string => typeof param === "string" && param.startsWith("wf_"))
      .map((workflowId) => this.specIdOf(workflowId));
    if (sql.startsWith('select "workflow_id" from "bindings"'))
      return `FindBinding(${bindingKeyOf(params)})`;
    if (sql.startsWith('select distinct "workflow_id" from "bindings"')) return FIND_PULL_WORKFLOWS;
    if (/^select .* from "workflows"/.test(sql)) return `FindWorkflow(${ids[0]})`;
    if (sql.startsWith('insert into "bindings"') && sql.includes("do nothing")) {
      return `ClaimBinding(${bindingKeyOf(params)})`;
    }
    if (sql.startsWith('update "bindings"'))
      return `ClaimBinding(${bindingKeyOf(params.slice(2))})`;
    if (sql.startsWith('insert into "bindings"'))
      return `BindWorkflow(${bindingKeyOf(params)}, ${ids[0]})`;
    if (sql.startsWith('insert into "workflows"')) return `InsertWorkflow(${ids[0]})`;
    if (sql.startsWith('delete from "bindings"')) return `DeleteBindings(${ids[0]})`;
    if (sql.startsWith('update "workflows"')) return `SetStatus(${ids[0]})`;
    throw new Error(`the replay does not name the statement ${sql}`);
  }
}

function required<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`the spec step did not pick a ${name}`);
  return value;
}

function eventKindOf(
  surface: SurfaceName,
  kind: EventKindName,
): Pick<InboundEvent, "kind" | "actor"> {
  switch (kind) {
    case "Start":
      return { kind: "start", actor: PERSON };
    case "StartWithoutAPerson":
      return { kind: "start", actor: null };
    case "PersonsMessage":
      return { kind: "prompt", actor: PERSON };
    case "OtherEvent":
      return { kind: surface === "PullSurface" ? "ci_event" : "status", actor: null };
    case "BaseMoved":
      return { kind: "pr_event", actor: null };
    default: {
      const unreachable: never = kind;
      throw new Error(`unhandled event kind ${String(unreachable)}`);
    }
  }
}

const FIND_PULL_WORKFLOWS = "FindPullWorkflows";

function pullKeyOf(number: number): PullKeyName {
  const pull = PULL_KEYS.find((key) => PULL_NUMBERS[key] === number);
  if (!pull) throw new Error(`the replay does not know the pull request #${number}`);
  return pull;
}

function firstText(row: object): string {
  return itfText(Object.values(row)[0]);
}

function bindingKeyOf(params: unknown[]): KeyName {
  const [source, externalId] = params;
  const key = BINDING_KEYS[`${String(source)}:${String(externalId)}`];
  if (!key)
    throw new Error(`the replay does not know the binding ${String(source)} ${String(externalId)}`);
  return key;
}

function bindingRow(row: unknown): { source: string; external_id: string; workflow_id: string } {
  return {
    source: itfText(itfField(row, "source")),
    external_id: itfText(itfField(row, "external_id")),
    workflow_id: itfText(itfField(row, "workflow_id")),
  };
}

const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "new",
  "running",
  "waiting_input",
  "done",
  "failed",
  "cancelled",
];

function workflowRow(row: unknown): { workflow_id: string; status: WorkflowStatus } {
  return {
    workflow_id: itfText(itfField(row, "workflow_id")),
    status: itfOneOf(itfText(itfField(row, "status")), WORKFLOW_STATUSES),
  };
}
