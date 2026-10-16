import { Database as SqliteDatabase } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import type { Actor, InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import {
  startTools,
  validateInputNotHeld,
  validateInputNotInWork,
} from "../src/agent/tools/start/start";
import type { ArtifactTarget } from "../src/artifact/types";
import type { Env } from "../src/env";
import { deliver } from "../src/router/deliver";
import { recordArtifact } from "../src/workflow/artifact";
import { failWorkflow, type JobInput } from "../src/workflow/lifecycle";
import { isWorkflowFinished } from "../src/workflow/store/state";
import { FakeRuntime, seedTask } from "./fake-runtime";
import { openMemoryDb } from "./memory-db";
import { testEnv } from "./test-env";

/** The setup modules of the router bindings spec. */
export const SPEC_SETUPS = [
  "chatThread",
  "twoSessionsOnOneIssue",
  "sessionWithPullRequest",
] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

/** The most steps a generated trace takes after its initial state. */
export const TRACE_STEPS = 25;

const SPEC_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../spec/router-bindings",
);
const QUINT_CLI = createRequire(import.meta.url).resolve("@informalsystems/quint/dist/src/cli.js");
const D1_MIGRATIONS = join(import.meta.dirname, "../migrations/d1");

const KEYS = ["Thread", "SessionA", "SessionB", "Issue", "Pull"] as const;

type KeyName = (typeof KEYS)[number];

const SURFACES = ["ThreadSurface", "SessionASurface", "SessionBSurface", "PullSurface"] as const;

type SurfaceName = (typeof SURFACES)[number];

const EVENT_KINDS = ["Start", "PersonsMessage", "OtherEvent"] as const;

type EventKindName = (typeof EVENT_KINDS)[number];

/** What the Durable Object of one workflow knows, as the spec sees it. */
export type ObjectView = {
  created: boolean;
  ended: boolean;
  holdsIssue: boolean;
  openedPull: boolean;
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
export type SpecPicks = {
  surface: SurfaceName | null;
  kind: EventKindName | null;
  delivery: number | null;
  workflow: number | null;
  operation: number | null;
};

/** One state of a trace: the action that led to it, what it picked, and the router as the spec sees it. */
export type TraceStep = { action: string; picks: SpecPicks; view: RouterView };

/** Run the spec of one setup for `count` traces from `seed`. */
export function generateTraces(setup: SpecSetup, count: number, seed: number): TraceStep[][] {
  const directory = mkdtempSync(join(tmpdir(), "router-bindings-"));
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
      .map((file) => traceSteps(JSON.parse(readFileSync(join(directory, file), "utf8"))));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function traceNumber(file: string): number {
  return Number(file.replace(/\D/g, ""));
}

function traceSteps(trace: unknown): TraceStep[] {
  return list(field(trace, "states")).map((state) => {
    const worldName = Object.keys(asRecord(state)).find((name) => name.endsWith("::world"));
    if (!worldName) throw new Error("the trace has no world");
    const picks = field(state, "mbt::nondetPicks");
    return {
      action: text(field(state, "mbt::actionTaken")),
      picks: {
        surface: pickedTag(picks, "surface", SURFACES),
        kind: pickedTag(picks, "kind", EVENT_KINDS),
        delivery: pickedInt(picks, "delivery"),
        workflow: pickedInt(picks, "workflow"),
        operation: pickedInt(picks, "operation"),
      },
      view: specView(field(state, worldName)),
    };
  });
}

function pickedValue(picks: unknown, name: string): unknown {
  const picked = variant(field(picks, name, true));
  return picked?.tag === "Some" ? picked.value : null;
}

function pickedInt(picks: unknown, name: string): number | null {
  const value = pickedValue(picks, name);
  return value === null ? null : int(value);
}

function pickedTag<Name extends string>(
  picks: unknown,
  name: string,
  names: readonly Name[],
): Name | null {
  const value = pickedValue(picks, name);
  return value === null ? null : oneOf(variant(value)!.tag, names);
}

function isNewObject(object: ObjectView): boolean {
  return Object.values(object).every((flag) => !flag);
}

type SpecDelivery = {
  surface: SurfaceName;
  phase: string;
  found: (number | null)[];
  index: number;
  target: number | null;
};

function specView(world: unknown): RouterView {
  const bindings: RouterView["bindings"] = {};
  for (const [key, workflow] of entries(field(world, "bindings"))) {
    bindings[oneOf(variant(key)!.tag, KEYS)] = int(workflow);
  }
  const rows: RouterView["rows"] = {};
  for (const [workflow, status] of entries(field(world, "rows"))) {
    rows[int(workflow)] = variant(status)!.tag === "Ended" ? "Ended" : "Live";
  }
  const objects: RouterView["objects"] = {};
  for (const [workflow, object] of entries(field(world, "objects"))) {
    const view: ObjectView = {
      created: bool(field(object, "created")),
      ended: bool(field(object, "ended")),
      holdsIssue: bool(field(object, "holdsIssue")),
      openedPull: bool(field(object, "openedPull")),
      unbound: bool(field(object, "unbound")),
    };
    if (!isNewObject(view)) objects[int(workflow)] = view;
  }
  const calls: RouterView["calls"] = {};
  for (const [id, delivery] of entries(field(world, "deliveries"))) {
    calls[`d${int(id)}`] = deliveryCall(specDelivery(delivery));
  }
  for (const [id, operation] of entries(field(world, "operations"))) {
    calls[`o${int(id)}`] = operationCall(
      int(field(operation, "workflow")),
      field(operation, "phase"),
    );
  }
  return { bindings, rows, objects, calls };
}

function specDelivery(delivery: unknown): SpecDelivery {
  const target = variant(field(delivery, "target"))!;
  return {
    surface: oneOf(variant(field(delivery, "surface"))!.tag, SURFACES),
    phase: variant(field(delivery, "phase"))!.tag,
    found: list(field(delivery, "found")).map((bound) => {
      const found = variant(bound)!;
      return found.tag === "BoundTo" ? int(found.value) : null;
    }),
    index: int(field(delivery, "index")),
    target: target.tag === "TargetWorkflow" ? int(target.value) : null,
  };
}

const SURFACE_KEYS: Record<SurfaceName, KeyName[]> = {
  ThreadSurface: ["Thread"],
  SessionASurface: ["SessionA", "Issue"],
  SessionBSurface: ["SessionB", "Issue"],
  PullSurface: ["Pull"],
};

function deliveryCall(delivery: SpecDelivery): string {
  const keys = SURFACE_KEYS[delivery.surface];
  const key = keys[delivery.index];
  switch (delivery.phase) {
    case "Reading":
      return `FindBinding(${keys[delivery.found.length]})`;
    case "Checking":
      return `FindWorkflow(${delivery.found[delivery.index]})`;
    case "Rebinding":
    case "Binding":
      return `BindWorkflow(${key}, ${delivery.target})`;
    case "Handling":
      return `HandleEvent(${delivery.target})`;
    case "Claiming":
      return `ClaimBinding(${key})`;
    case "Inserting":
      return `InsertWorkflow(${delivery.target})`;
    case "Creating":
      return `CreateWorkflow(${delivery.target})`;
    case "Unbinding":
      return `DeleteBindings(${delivery.target})`;
    case "Restoring":
      return `BindWorkflow(${key}, ${delivery.found[delivery.index]})`;
    case "MarkingFailed":
      return `SetStatus(${delivery.target})`;
    default:
      throw new Error(`the trace has the delivery phase ${delivery.phase}`);
  }
}

function operationCall(workflow: number, phase: unknown): string {
  const named = variant(phase)!;
  switch (named.tag) {
    case "EndWritesStatus":
      return `SetStatus(${workflow})`;
    case "EndUnbindsCodeHost":
      return `DeleteBindings(${workflow})`;
    case "JobReadsIssueOwner":
      return "FindBinding(Issue)";
    case "JobAsksIssueOwner":
      return `HeldInput(${int(named.value)})`;
    case "JobBindsIssue":
      return `BindWorkflow(Issue, ${workflow})`;
    case "PullBinds":
      return `BindWorkflow(Pull, ${workflow})`;
    default:
      throw new Error(`the trace has the operation phase ${named.tag}`);
  }
}

function entries(map: unknown): [unknown, unknown][] {
  return list(field(map, "#map")).map((pair) => {
    const [key, value] = list(pair);
    return [key, value];
  });
}

function asRecord(value: unknown): object {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the trace has ${JSON.stringify(value)}, not a record`);
  }
  return value;
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

const PULL_TARGET: ArtifactTarget = {
  url: "https://github.com/acme/app/pull/7",
  ref: { kind: "pull", repo: "acme/app", number: 7 },
};

const PERSON: Actor = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

/** The spec key of each binding, by source and external id as the router stores them. */
const BINDING_KEYS: Record<string, KeyName> = {
  "chat_thread:C1:1.0": "Thread",
  "tracker_session:sess-a": "SessionA",
  "tracker_session:sess-b": "SessionB",
  [`tracker_issue:${ISSUE.id}`]: "Issue",
  "code_pull:acme/app#7": "Pull",
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

const SURFACE_EVENTS: Record<SurfaceName, { bindings: Binding[]; reply_to?: ReplyTarget }> = {
  ThreadSurface: {
    bindings: [{ source: "chat_thread", external_id: "C1:1.0" }],
    reply_to: { source: "chat", channel: "C1", thread: "1.0" },
  },
  SessionASurface: trackerSession("sess-a"),
  SessionBSurface: trackerSession("sess-b"),
  PullSurface: { bindings: [{ source: "code_pull", repo: "acme/app", number: 7 }] },
};

const call = { toolCallId: "call-1", messages: [], context: {} };

/**
 * Replays spec traces through the router's deliveries and the workflows' own binding writes.
 * Every D1 statement and Durable Object call waits until a spec step lets it land.
 */
export class RouterBindingsReplay {
  private readonly gate = new CallGate();
  private readonly sqlite = migratedD1Database();
  private readonly runtimes = new Map<string, FakeRuntime>();
  private readonly unbound = new Set<string>();
  private readonly workflowIds: string[] = [];
  private readonly env: Env;
  private nextDelivery = 0;
  private nextOperation = 0;
  private nextEvent = 0;

  constructor() {
    const namespace: object = {
      getByName: (name: string) => ({
        create: () =>
          this.gate.hold(`CreateWorkflow(${this.specIdOf(name)})`, () => this.createRuntime(name)),
        handle: () => this.gate.hold(`HandleEvent(${this.specIdOf(name)})`, () => ({ ok: true })),
        heldInput: (input: JobInput) =>
          this.gate.hold(`HeldInput(${this.specIdOf(name)})`, () => this.heldInputOf(name, input)),
      }),
    };
    this.env = { ...testEnv(), DB: this.gatedD1(), Workflow: namespace as Env["Workflow"] };
  }

  /** Take one spec action. */
  async take(step: TraceStep): Promise<void> {
    const { picks } = step;
    switch (step.action) {
      case "eventArrives":
        return this.eventArrives(required(picks.surface, "surface"), required(picks.kind, "kind"));
      case "deliveryResumes":
        return this.gate.land(`d${required(picks.delivery, "delivery")}`);
      case "workflowCreateReturns":
        return this.gate.land(`d${required(picks.delivery, "delivery")}`);
      case "workflowCreateFails":
        return this.gate.fail(
          `d${required(picks.delivery, "delivery")}`,
          new Error("Durable Object reset"),
        );
      case "workflowCallReturns":
        return this.gate.land(`o${required(picks.operation, "operation")}`);
      case "workflowEnds":
        return this.startOperation(required(picks.workflow, "workflow"), (runtime) =>
          this.endWorkflow(runtime),
        );
      case "workflowStartsAJobOnTheIssue":
        return this.startOperation(required(picks.workflow, "workflow"), (runtime) =>
          this.startJobOnTheIssue(runtime),
        );
      case "workflowOpensThePullRequest":
        return this.startOperation(required(picks.workflow, "workflow"), (runtime) =>
          this.openPullRequest(runtime),
        );
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
      const view: ObjectView = {
        created: true,
        ended: isWorkflowFinished(runtime.state.status),
        holdsIssue: validateInputNotInWork(runtime, ISSUE_INPUT) !== null,
        openedPull: runtime.store.artifacts().some((artifact) => artifact.kind === "pull"),
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

  private async eventArrives(surface: SurfaceName, kind: EventKindName): Promise<void> {
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
    await this.gate.start(name, () => deliver(this.env, event, null));
  }

  private async startOperation(
    workflow: number,
    run: (runtime: FakeRuntime) => Promise<unknown>,
  ): Promise<void> {
    const name = this.workflowIds[workflow];
    const runtime = name ? this.runtimes.get(name) : undefined;
    if (!name || !runtime) throw new Error(`workflow ${workflow} has no Durable Object`);
    const operation = `o${this.nextOperation}`;
    this.nextOperation += 1;
    await this.gate.start(operation, () => run(runtime));
  }

  private async endWorkflow(runtime: FakeRuntime): Promise<void> {
    await failWorkflow(runtime, "the replay ends it");
    this.unbound.add(runtime.state.workflow_id);
  }

  private async startJobOnTheIssue(runtime: FakeRuntime): Promise<void> {
    await startTools(runtime).start_job.execute(
      { stage: "breakdown", brief: "Break the issue down.", issue: ISSUE.identifier },
      call,
    );
  }

  private async openPullRequest(runtime: FakeRuntime): Promise<void> {
    const author = seedTask(runtime, {
      task_id: `${runtime.state.workflow_id}.9`,
      job_id: `${runtime.state.workflow_id}-9`,
      stage: "implement",
    });
    await recordArtifact(runtime, author, PULL_TARGET);
  }

  private createRuntime(name: string): { ok: true } {
    const runtime = new FakeRuntime(openMemoryDb(), this.env);
    runtime.patchState({
      workflow_id: name,
      subject: { kind: "issue", issue_id: ISSUE.id },
      concurrency: 2,
    });
    runtime.trackerInstance = new FakeTracker({ issues: [ISSUE] });
    this.runtimes.set(name, runtime);
    return { ok: true };
  }

  private heldInputOf(name: string, input: JobInput): Promise<string | null> | null {
    const runtime = this.runtimes.get(name);
    return runtime ? validateInputNotHeld(runtime, input) : null;
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
      const execute = <Result>(run: () => Result) => this.gate.hold(named, run);
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

  /** The call a D1 statement makes, as the spec names it. A new workflow id gets the next number. */
  private statementCall(sql: string, params: unknown[]): string {
    const ids = params
      .filter((param): param is string => typeof param === "string" && param.startsWith("wf_"))
      .map((workflowId) => this.specIdOf(workflowId));
    if (sql.startsWith('select "workflow_id" from "bindings"'))
      return `FindBinding(${bindingKeyOf(params)})`;
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
    case "PersonsMessage":
      return { kind: "prompt", actor: PERSON };
    case "OtherEvent":
      return { kind: surface === "PullSurface" ? "ci_event" : "status", actor: null };
    default: {
      const unreachable: never = kind;
      throw new Error(`unhandled event kind ${String(unreachable)}`);
    }
  }
}

function bindingKeyOf(params: unknown[]): KeyName {
  const [source, externalId] = params;
  const key = BINDING_KEYS[`${String(source)}:${String(externalId)}`];
  if (!key)
    throw new Error(`the replay does not know the binding ${String(source)} ${String(externalId)}`);
  return key;
}

type SqliteParam = string | number | bigint | boolean | null;

function sqliteParams(params: unknown[]): SqliteParam[] {
  return params.map((param) => {
    if (
      param === null ||
      typeof param === "string" ||
      typeof param === "number" ||
      typeof param === "bigint" ||
      typeof param === "boolean"
    ) {
      return param;
    }
    throw new Error(`the replay cannot bind ${JSON.stringify(param)}`);
  });
}

function bindingRow(row: unknown): { source: string; external_id: string; workflow_id: string } {
  return {
    source: text(field(row, "source")),
    external_id: text(field(row, "external_id")),
    workflow_id: text(field(row, "workflow_id")),
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
    workflow_id: text(field(row, "workflow_id")),
    status: oneOf(text(field(row, "status")), WORKFLOW_STATUSES),
  };
}

function migratedD1Database(): SqliteDatabase {
  const database = new SqliteDatabase(":memory:");
  for (const file of readdirSync(D1_MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    for (const statement of readFileSync(join(D1_MIGRATIONS, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) database.run(statement);
    }
  }
  return database;
}
