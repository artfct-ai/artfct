import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ConversationPlace } from "@artfct-ai/contracts/sources";
import type { Delivery, WorkflowStatus } from "@artfct-ai/contracts/types";
import { eq } from "drizzle-orm";
import { planTools } from "../src/agent/tools/plan";
import { startTools, validateInputNotInWork } from "../src/agent/tools/start/start";
import type { ArtifactTarget } from "../src/artifact/types";
import { loadWorkflowDefinition } from "../src/config/workflow-definition";
import { createDb } from "../src/db/client";
import { conversationIdOf, type PullRequestPlace } from "../src/db/conversations";
import type { Env } from "../src/env";
import { deliver } from "../src/router/deliver";
import { consumeFiring, type FiringConsumer } from "../src/triggers/consumer";
import type { TriggerFiring } from "../src/triggers/types";
import { recordArtifact } from "../src/workflow/artifact";
import { applyVerbalCommand } from "../src/workflow/inbound/controls";
import { deliverToConversation } from "../src/workflow/inbound/events";
import { fireWorkflow } from "../src/workflow/inbound/firing";
import {
  completeWorkflow,
  failWorkflow,
  resumeWorkflowEnd,
  writeRouterWorkflowStatus,
  type JobInput,
} from "../src/workflow/lifecycle";
import { artifacts, jobs, workflows } from "../src/workflow/store/schema";
import { isWorkflowFinished } from "../src/workflow/store/state";
import { FakeRuntime, patchStagePlan, seedTask } from "./fake-runtime";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { openMemoryDb, type MemoryDb } from "./memory-db";
import { quintTraces } from "./quint-traces";
import { runStartStep } from "./restart";
import { migratedD1Database, sqliteParams } from "./sqlite-d1";
import { TEST_CONFIG } from "./test-config";
import { testEnv } from "./test-env";

/** The setup modules of the router bindings spec. */
export const SPEC_SETUPS = [
  "chatThread",
  "issueAndThread",
  "sessionWithPullRequest",
  "baseMoveFanOut",
  "watchedPullRequest",
  "ownedAndWatchedPullRequest",
] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

const PLACES = [
  "Thread",
  "IssuePlace",
  "LooseSession",
  "PullRequestPlace(0)",
  "PullRequestPlace(1)",
] as const;

/** A place, as the spec names it. A pull request's place carries its definition's index. */
export type PlaceName = (typeof PLACES)[number];

const KEYS = ["Issue", "Pull", "SecondPull"] as const;

type KeyName = (typeof KEYS)[number];

const PULL_KEYS = ["Pull", "SecondPull"] as const;

type PullKeyName = (typeof PULL_KEYS)[number];

const SURFACES = [
  "ThreadSurface",
  "SessionSurface",
  "LooseSessionSurface",
  "PullSurface",
  "BaseSurface",
] as const;

type SurfaceName = (typeof SURFACES)[number];

const EVENT_KINDS = ["Start", "Reply", "BaseMoved", "Closed"] as const;

type EventKindName = (typeof EVENT_KINDS)[number];

const WORKFLOW_STATUSES = ["Running", "Ending", "Done"] as const;

type WorkflowStatusName = (typeof WORKFLOW_STATUSES)[number];

const ROW_STATUSES = ["Live", "Ended"] as const;

type RowStatusName = (typeof ROW_STATUSES)[number];

/** Work a conversation does against the router's tables. */
export type ConversationWork = "end" | "job_on_issue" | "pull_request" | "second_pull_request";

/** The statuses a workflow ends with. The spec reads each one as ended. */
const ENDED_STATUSES = ["done", "failed", "cancelled"] as const;

type EndedStatus = (typeof ENDED_STATUSES)[number];

/** One workflow in its conversation's store, as the spec sees it. */
type WorkflowView = {
  conversation: PlaceName;
  status: WorkflowStatusName;
  hasIssueJob: boolean;
  recordedPulls: PullKeyName[];
};

/**
 * The router's tables, the conversations, and the call each delivery and workflow operation waits
 * on. Workflows are numbered in the order they were first seen.
 */
export type RouterView = {
  bindings: Partial<Record<KeyName, number>>;
  rows: Record<number, RowStatusName>;
  recorded: PlaceName[];
  opened: PlaceName[];
  watches: number[];
  workflows: Record<number, WorkflowView>;
  calls: Record<string, string>;
};

/** What a spec action picked. */
type SpecPicks = {
  surface: SurfaceName | null;
  kind: EventKindName | null;
  delivery: number | null;
  place: PlaceName | null;
  workflow: number | null;
  operation: number | null;
  pull: PullKeyName | null;
  definition: number | null;
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
  return quintTraces({ spec: "router-bindings", setup, count, steps: TRACE_STEPS, seed }, (trace) =>
    traceSteps(trace),
  );
}

/** The steps of one ITF trace of the spec. */
function traceSteps(trace: unknown): TraceStep[] {
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
        place: pickedPlace(picks),
        workflow: pickedInt(picks, "workflow"),
        operation: pickedInt(picks, "operation"),
        pull: pickedTag(picks, "pull", PULL_KEYS),
        definition: pickedInt(picks, "definition"),
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
  return value === null ? null : tagOf(value, names);
}

function pickedPlace(picks: unknown): PlaceName | null {
  const value = pickedValue(picks, "place");
  return value === null ? null : placeNameOf(value);
}

function tagOf<Name extends string>(value: unknown, names: readonly Name[]): Name {
  return itfOneOf(itfVariant(value)!.tag, names);
}

function placeNameOf(value: unknown): PlaceName {
  const { tag, value: definition } = itfVariant(value)!;
  const name = tag === "PullRequestPlace" ? `${tag}(${itfInt(definition)})` : tag;
  return itfOneOf(name, PLACES);
}

function specView(world: unknown): RouterView {
  const bindings: RouterView["bindings"] = {};
  for (const [key, workflow] of entries(itfField(world, "bindings"))) {
    bindings[tagOf(key, KEYS)] = itfInt(workflow);
  }
  const rows: RouterView["rows"] = {};
  for (const [workflow, status] of entries(itfField(world, "rows"))) {
    rows[itfInt(workflow)] = tagOf(status, ROW_STATUSES);
  }
  const places = (field: string) => itfSet(itfField(world, field)).map(placeNameOf).toSorted();
  const flows: RouterView["workflows"] = {};
  for (const [workflow, flow] of entries(itfField(world, "workflows"))) {
    flows[itfInt(workflow)] = {
      conversation: placeNameOf(itfField(flow, "conversation")),
      status: tagOf(itfField(flow, "status"), WORKFLOW_STATUSES),
      hasIssueJob: itfBool(itfField(flow, "hasIssueJob")),
      recordedPulls: itfSet(itfField(flow, "recordedPulls"))
        .map((pull) => tagOf(pull, PULL_KEYS))
        .toSorted(),
    };
  }
  const calls: RouterView["calls"] = {};
  for (const [id, delivery] of entries(itfField(world, "deliveries"))) {
    calls[`d${itfInt(id)}`] = deliveryCall(delivery);
  }
  for (const [id, operation] of entries(itfField(world, "operations"))) {
    calls[`o${itfInt(id)}`] = operationCall(
      itfInt(itfField(operation, "workflow")),
      itfField(operation, "phase"),
    );
  }
  return {
    bindings,
    rows,
    recorded: places("recorded"),
    opened: places("opened"),
    watches: itfSet(itfField(world, "watches"))
      .map((definition) => itfInt(definition))
      .toSorted((left, right) => left - right),
    workflows: flows,
    calls,
  };
}

const SURFACE_KEYS: Record<SurfaceName, KeyName[]> = {
  ThreadSurface: [],
  SessionSurface: ["Issue"],
  LooseSessionSurface: [],
  PullSurface: ["Pull"],
  BaseSurface: [],
};

const SURFACE_PLACES: Record<SurfaceName, PlaceName | null> = {
  ThreadSurface: "Thread",
  SessionSurface: "IssuePlace",
  LooseSessionSurface: "LooseSession",
  PullSurface: null,
  BaseSurface: null,
};

function deliveryCall(delivery: unknown): string {
  const surface = tagOf(itfField(delivery, "surface"), SURFACES);
  const phase = itfVariant(itfField(delivery, "phase"))!;
  switch (phase.tag) {
    case "ReadingBinding":
      return `FindBoundConversation(${SURFACE_KEYS[surface][itfInt(phase.value)]})`;
    case "RecordingConversation":
      return `RecordConversation(${SURFACE_PLACES[surface]})`;
    case "CheckingConversation":
      return `FindConversation(${SURFACE_PLACES[surface]})`;
    case "Handling":
      return `HandleEvent(${placeNameOf(phase.value)})`;
    case "ReadingPulls":
      return FIND_PULL_CONVERSATIONS;
    case "ReadingWatchers":
      return FIND_WATCHERS;
    case "FanningOut":
      return `HandleEvent(${placeNameOf(itfField(phase.value, "conversation"))})`;
    default:
      throw new Error(`the trace has the delivery phase ${phase.tag}`);
  }
}

function operationCall(workflow: number, phase: unknown): string {
  const named = itfVariant(phase)!;
  switch (named.tag) {
    case "PlanWritesRow":
    case "FireWritesRow":
    case "RestartWritesRow":
    case "EndWritesStatus":
      return `WriteWorkflowRow(${workflow})`;
    case "EndUnbinds":
      return `DeleteBindings(${workflow})`;
    case "JobReadsIssueBinding":
      return "FindBinding(Issue)";
    case "JobReadsBoundWorkflow":
      return `FindWorkflow(${itfInt(named.value)})`;
    case "JobBindsIssue":
      return "ClaimBinding(Issue)";
    case "PullBinds":
      return `BindWorkflow(${tagOf(named.value, PULL_KEYS)}, ${workflow})`;
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

/** A D1 statement the replay holds, with what it runs. */
type GatedStatement = {
  sql: string;
  params: unknown[];
  run: () => Promise<unknown>;
  all: () => Promise<unknown>;
  raw: () => Promise<unknown>;
  first: () => Promise<unknown>;
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
   * Drop a caller whose instance or invocation ended. The call it waits on lands first when
   * `landed` is set. The caller never hears back.
   */
  async drop(name: string, landed: boolean): Promise<void> {
    const { caller, waiting } = this.waitingOf(name);
    this.callers.delete(name);
    if (!landed) return;
    const running = this.running;
    this.running = caller;
    await waiting.land();
    this.running = running;
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

const PULL_WORK: Record<PullKeyName, ConversationWork> = {
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

const PERSON: Actor = { email: "dev@acme.test", display_name: "Dev" };

/** The event the watch definitions' triggers fire on. */
const PULL_REQUEST_EVENT = "github.pull_request.synchronize";

/** The definitions whose triggers fire on the pull request, by the index the spec gives each. */
const WATCH_DEFINITIONS = ["review", "audit"].map((name) =>
  loadWorkflowDefinition(
    name,
    [
      TEST_CONFIG.workflowDefinitions[0]!.text,
      "triggers:",
      `  - { event: ${PULL_REQUEST_EVENT}, prompt: Review the change. }`,
    ].join("\n"),
  ),
);

const WATCHER_PLACES = ["PullRequestPlace(0)", "PullRequestPlace(1)"] as const;

function watcherPlace(definition: number): PlaceName {
  return WATCHER_PLACES[definition]!;
}

function isWatcherPlace(place: PlaceName): boolean {
  return WATCHER_PLACES.some((watcher) => watcher === place);
}

const PLACE_OF = {
  Thread: { source: "chat_thread", channel: "C1", thread: "1.0" },
  IssuePlace: { source: "tracker_issue", issue_id: ISSUE.id },
  LooseSession: { source: "tracker_session", session_id: "sess-loose" },
  "PullRequestPlace(0)": {
    source: "pull_request",
    repo: REPO,
    number: PULL_NUMBERS.Pull,
    definition: WATCH_DEFINITIONS[0]!.name,
  },
  "PullRequestPlace(1)": {
    source: "pull_request",
    repo: REPO,
    number: PULL_NUMBERS.Pull,
    definition: WATCH_DEFINITIONS[1]!.name,
  },
} satisfies Record<PlaceName, ConversationPlace | PullRequestPlace>;

/** The spec place of each conversation row, by source and external id as the router stores them. */
const RECORDED_PLACES: Record<string, PlaceName> = {
  "chat_thread:C1:1.0": "Thread",
  [`tracker_issue:${ISSUE.id}`]: "IssuePlace",
  "tracker_session:sess-loose": "LooseSession",
};

const CONVERSATION_IDS: Record<PlaceName, string> = {
  Thread: await conversationIdOf(PLACE_OF.Thread),
  IssuePlace: await conversationIdOf(PLACE_OF.IssuePlace),
  LooseSession: await conversationIdOf(PLACE_OF.LooseSession),
  "PullRequestPlace(0)": await conversationIdOf(PLACE_OF["PullRequestPlace(0)"]),
  "PullRequestPlace(1)": await conversationIdOf(PLACE_OF["PullRequestPlace(1)"]),
};

/** The spec key of each binding, by source and external id as the router stores them. */
const BINDING_KEYS: Record<string, KeyName> = {
  [`tracker_issue:${ISSUE.id}`]: "Issue",
  [`code_pull:${REPO}#${PULL_NUMBERS.Pull}`]: "Pull",
  [`code_pull:${REPO}#${PULL_NUMBERS.SecondPull}`]: "SecondPull",
};

const SURFACE_EVENTS: Record<
  SurfaceName,
  Pick<InboundEvent, "bindings" | "reply_to" | "pull" | "place">
> = {
  ThreadSurface: {
    bindings: [],
    reply_to: { source: "chat", channel: "C1", thread: "1.0" },
    place: PLACE_OF.Thread,
  },
  SessionSurface: {
    bindings: [{ source: "tracker_issue", external_id: ISSUE.id }],
    reply_to: { source: "tracker", session_id: "sess-a", issue_id: ISSUE.id, team_id: "team-1" },
    place: PLACE_OF.IssuePlace,
  },
  LooseSessionSurface: {
    bindings: [],
    reply_to: { source: "tracker", session_id: "sess-loose", issue_id: "" },
    place: PLACE_OF.LooseSession,
  },
  PullSurface: { bindings: [{ source: "code_pull", repo: REPO, number: PULL_NUMBERS.Pull }] },
  BaseSurface: { bindings: [], pull: { action: "base_moved", repo: REPO, base: "main" } },
};

const call = { toolCallId: "call-1", messages: [], context: {} };

/** One conversation's Durable Object: its store's database and its instance now. */
type ConversationObject = { db: MemoryDb; runtime: FakeRuntime };

/**
 * Replays spec traces through the router's deliveries and the conversations' own writes to the
 * router's tables. Every D1 statement and Durable Object call waits until a spec step lets it
 * land. Each workflow end takes the next ended status in turn, from the one `firstEndedStatus`
 * picks.
 */
export class RouterBindingsReplay {
  private readonly gate = new CallGate();
  private readonly sqlite = migratedD1Database();
  private readonly conversations = new Map<PlaceName, ConversationObject>();
  private readonly operationPlaces = new Map<string, PlaceName>();
  private readonly delivered = new Map<string, Delivery>();
  private readonly workflowIds: string[] = [];
  private readonly env: Env;
  private nextDelivery = 0;
  private nextOperation = 0;
  private nextEvent = 0;
  private nextFiring = 0;
  private nextMerged = true;
  private nextEndedStatus: number;

  constructor(firstEndedStatus = 0) {
    this.nextEndedStatus = firstEndedStatus;
    const namespace: object = {
      getByName: (name: string) => ({
        handle: (conversationId: string, event: InboundEvent) => {
          const place = placeOfConversation(name);
          return this.gate.hold(`HandleEvent(${place})`, () =>
            deliverToConversation(this.conversationOf(place).runtime, { conversationId, event }),
          );
        },
      }),
    };
    this.env = {
      ...testEnv(),
      DB: this.gatedD1(),
      Conversation: namespace as Env["Conversation"],
    };
  }

  /** Take one spec action. */
  async take(step: TraceStep): Promise<void> {
    const { picks } = step;
    switch (step.action) {
      case "eventArrives":
        await this.arrive(required(picks.surface, "surface"), required(picks.kind, "kind"));
        return;
      case "deliveryResumes":
        await this.gate.land(`d${required(picks.delivery, "delivery")}`);
        await this.startArmedEnds();
        return;
      case "fanOutCallFails":
        return this.gate.fail(
          `d${required(picks.delivery, "delivery")}`,
          new Error("Durable Object reset"),
        );
      case "routerInvocationEnds":
        await this.endRouterInvocation(
          `d${required(picks.delivery, "delivery")}`,
          required(picks.landed, "landed"),
        );
        await this.startArmedEnds();
        return;
      case "aPullRequestFiringLands":
        await this.fire(required(picks.definition, "definition"));
        return;
      case "conversationPlansAWorkflow":
        await this.plan(required(picks.place, "place"));
        return;
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
      case "workflowCallReturns":
        return this.gate.land(`o${required(picks.operation, "operation")}`);
      case "conversationRestarts":
        return this.restart(
          `o${required(picks.operation, "operation")}`,
          required(picks.landed, "landed"),
        );
      default:
        throw new Error(`no replay for spec action ${step.action}`);
    }
  }

  /** The router and the conversations as the spec sees them. */
  project(): RouterView {
    const bindings: RouterView["bindings"] = {};
    for (const row of this.sqlite
      .query("select source, external_id, workflow_id from bindings")
      .all()) {
      const key = BINDING_KEYS[`${textOf(row, "source")}:${textOf(row, "external_id")}`];
      if (!key) throw new Error(`the router bound ${JSON.stringify(row)}`);
      bindings[key] = this.specIdOf(textOf(row, "workflow_id"));
    }
    const rows: RouterView["rows"] = {};
    for (const row of this.sqlite.query("select workflow_id, status from workflows").all()) {
      const status = itfOneOf(textOf(row, "status"), ROUTER_STATUSES);
      rows[this.specIdOf(textOf(row, "workflow_id"))] = isWorkflowFinished(status)
        ? "Ended"
        : "Live";
    }
    const watches = this.sqlite
      .query("select definition from watches")
      .all()
      .map((row) => watchDefinitionIndex(textOf(row, "definition")))
      .toSorted((left, right) => left - right);
    const recorded = this.sqlite
      .query("select source, external_id from conversations")
      .all()
      .map((row) => {
        const place = RECORDED_PLACES[`${textOf(row, "source")}:${textOf(row, "external_id")}`];
        if (!place) throw new Error(`the router recorded ${JSON.stringify(row)}`);
        return place;
      })
      .toSorted();
    const opened: PlaceName[] = [];
    const flows: RouterView["workflows"] = {};
    for (const [place, { db, runtime }] of this.conversations) {
      if (runtime.store.conversation()) opened.push(place);
      Object.assign(flows, this.workflowsOf(place, db, runtime));
    }
    return {
      bindings,
      rows,
      recorded,
      opened: opened.toSorted(),
      watches,
      workflows: flows,
      calls: this.gate.calls(),
    };
  }

  private workflowsOf(
    place: PlaceName,
    db: MemoryDb,
    runtime: FakeRuntime,
  ): RouterView["workflows"] {
    const active = runtime.store.activeWorkflow()?.workflow_id;
    const recorded = db
      .select({ ref: artifacts.ref, workflow_id: jobs.workflow_id })
      .from(artifacts)
      .innerJoin(jobs, eq(jobs.job_id, artifacts.job_id))
      .all();
    const flows: RouterView["workflows"] = {};
    for (const flow of db.select().from(workflows).all()) {
      flows[this.specIdOf(flow.workflow_id)] = {
        conversation: place,
        status: workflowStatusOf(flow.status),
        hasIssueJob:
          flow.workflow_id === active && validateInputNotInWork(runtime, ISSUE_INPUT) !== null,
        recordedPulls: recorded
          .flatMap(({ ref, workflow_id }) =>
            workflow_id === flow.workflow_id && ref.kind === "pull" ? [pullKeyOf(ref.number)] : [],
          )
          .toSorted(),
      };
    }
    return flows;
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
      ...this.eventKindOf(surface, kind),
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

  /** The agent of an opened conversation plans a workflow. Answers the name of its operation. */
  async plan(place: PlaceName): Promise<string> {
    const { runtime } = this.conversationOf(place);
    return this.startOperation(place, async () => {
      await planTools(runtime).set_plan.execute(
        { name: "Ship it", definition: "development", reason: "the replay plans it" },
        call,
      );
    });
  }

  /**
   * A firing of a watch definition's trigger on the pull request goes through the firing queue's
   * consumer to its conversation. Answers the name of its operation.
   */
  async fire(definition: number): Promise<string> {
    this.nextFiring += 1;
    const firing: TriggerFiring = {
      cause: {
        kind: "vendor_event",
        delivery_id: `delivery-${this.nextFiring}`,
        event: PULL_REQUEST_EVENT,
        payload: "{}",
      },
      reports: { kind: "pull_request", repo: REPO, number: PULL_NUMBERS.Pull },
      definition: WATCH_DEFINITIONS[definition]!.name,
      position: 0,
      attempt: 1,
    };
    const consumer: FiringConsumer = {
      db: createDb(this.env.DB),
      chat: null,
      code: null,
      definitions: WATCH_DEFINITIONS,
      fire: (conversationId, conversationFiring) =>
        fireWorkflow(this.conversationOf(placeOfConversation(conversationId)).runtime, {
          conversationId,
          firing: conversationFiring,
        }),
      sendAttempt: async () => {
        throw new Error("the firing failed its attempt, which the spec does not model");
      },
    };
    return this.startOperation(watcherPlace(definition), () => consumeFiring(consumer, firing));
  }

  /** The active workflow of a conversation starts work on the router's tables. Answers the name of its operation. */
  async startWork(workflow: number, work: ConversationWork): Promise<string> {
    const place = this.placeOfWorkflow(workflow);
    const { runtime } = this.conversationOf(place);
    if (runtime.store.activeWorkflow()?.workflow_id !== this.workflowIds[workflow]) {
      throw new Error(`workflow ${workflow} is not the active workflow of ${place}`);
    }
    switch (work) {
      case "end":
        return this.startOperation(place, () => this.endWorkflow(runtime));
      case "job_on_issue":
        return this.startOperation(place, async () => {
          await startTools(runtime).start_job.execute(
            { stage: "breakdown", brief: "Break the issue down.", issue: ISSUE.identifier },
            call,
          );
        });
      case "pull_request":
        return this.startOperation(place, () => this.openPullRequest(runtime, "Pull"));
      case "second_pull_request":
        return this.startOperation(place, () => this.openPullRequest(runtime, "SecondPull"));
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

  /** The router's invocation ends while `delivery` waits on a call, which lands first when `landed` is set. */
  async endRouterInvocation(delivery: string, landed: boolean): Promise<void> {
    await this.gate.drop(delivery, landed);
  }

  /**
   * The Durable Object of the conversation whose call `operation` waits on restarts. The call
   * lands first when `landed` is set. Every call the conversation has out is lost. The new instance
   * writes the row of its active workflow, then runs the start step, which goes on with an end.
   */
  async restart(operation: string, landed: boolean): Promise<void> {
    const place = this.operationPlaces.get(operation);
    if (!place) throw new Error(`${operation} is not the work of a conversation`);
    await this.gate.drop(operation, landed);
    for (const [other, otherPlace] of this.operationPlaces) {
      if (otherPlace === place && this.gate.calls()[other]) await this.gate.drop(other, false);
    }
    const object = this.conversationOf(place);
    const restarted = object.runtime.restarted();
    object.runtime = restarted;
    if (!restarted.store.activeWorkflow()) {
      await runStartStep(restarted);
      return;
    }
    await this.startOperation(place, async () => {
      await writeRouterWorkflowStatus(restarted);
      await runStartStep(restarted);
    });
  }

  /** What a finished delivery answered, or undefined while it runs or after it threw. */
  deliveryOf(delivery: string): Delivery | undefined {
    return this.delivered.get(delivery);
  }

  /**
   * Each conversation whose end a close left to its alarm: the alarm fires, and the end goes on as
   * a workflow operation.
   */
  private async startArmedEnds(): Promise<void> {
    for (const [place, { runtime }] of this.conversations) {
      for (const alarm of runtime.alarmsFor("resumeWorkflowEnd")) {
        await runtime.cancelAlarm(alarm.id);
        await this.startOperation(place, () => resumeWorkflowEnd(runtime));
      }
    }
  }

  private async startOperation(place: PlaceName, run: () => Promise<unknown>): Promise<string> {
    const operation = `o${this.nextOperation}`;
    this.nextOperation += 1;
    this.operationPlaces.set(operation, place);
    await this.gate.start(operation, run);
    return operation;
  }

  private placeOfWorkflow(workflow: number): PlaceName {
    const workflowId = this.workflowIds[workflow];
    for (const [place, { runtime }] of this.conversations) {
      if (runtime.store.activeWorkflow()?.workflow_id === workflowId) return place;
    }
    throw new Error(`workflow ${workflow} is not active in any conversation`);
  }

  private async endWorkflow(runtime: FakeRuntime): Promise<void> {
    const status = ENDED_STATUSES[this.nextEndedStatus % ENDED_STATUSES.length]!;
    this.nextEndedStatus += 1;
    await this.endWorkflowWith(runtime, status);
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

  /** The author finds its pull request. One whose earlier find a restart cut off finds it again. */
  private async openPullRequest(runtime: FakeRuntime, pull: PullKeyName): Promise<void> {
    const workflowId = runtime.store.requireWorkflowRow().workflow_id;
    const taskId = `${workflowId}.9`;
    const author =
      runtime.store.task(taskId) ??
      seedTask(runtime, { task_id: taskId, job_id: `${workflowId}-9`, stage: "implement" });
    await recordArtifact(runtime, author, pullTarget(pull));
  }

  /** What an event of a kind carries. A close alternates between a merge and a close without one. */
  private eventKindOf(
    surface: SurfaceName,
    kind: EventKindName,
  ): Pick<InboundEvent, "kind" | "actor" | "pull"> {
    switch (kind) {
      case "Start":
        return { kind: "start", actor: PERSON };
      case "Reply":
        return surface === "PullSurface"
          ? { kind: "ci_event", actor: null }
          : { kind: "prompt", actor: PERSON };
      case "BaseMoved":
        return { kind: "pr_event", actor: null };
      case "Closed": {
        const merged = this.nextMerged;
        this.nextMerged = !merged;
        return {
          kind: "pr_event",
          actor: null,
          pull: { action: "closed", repo: REPO, number: PULL_NUMBERS.Pull, merged },
        };
      }
      default: {
        const unreachable: never = kind;
        throw new Error(`unhandled event kind ${String(unreachable)}`);
      }
    }
  }

  /**
   * The Durable Object of a conversation. It exists, unopened, from the first call on it. Each
   * workflow its plan creates gets the issue as its subject and room for two jobs, in the same
   * synchronous block. A pull request's conversation runs the watch definitions, and its screen
   * admits every payload.
   */
  private conversationOf(place: PlaceName): ConversationObject {
    const known = this.conversations.get(place);
    if (known) return known;
    const db = openMemoryDb();
    const runtime = new FakeRuntime(db, this.env, "uncreated");
    runtime.trackerInstance = new FakeTracker({ issues: [ISSUE] });
    const object = { db, runtime };
    this.conversations.set(place, object);
    if (isWatcherPlace(place)) {
      runtime.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions({}) });
      runtime.workflowDefinitionsOverride = [
        ...runtime.workflowDefinitions(),
        ...WATCH_DEFINITIONS,
      ];
      return object;
    }
    const createWorkflow = runtime.store.createWorkflow.bind(runtime.store);
    runtime.store.createWorkflow = (created) => {
      createWorkflow({ ...created, subject: { kind: "issue", issue_id: ISSUE.id } });
      patchStagePlan(runtime, { job_slots: 2 });
    };
    return object;
  }

  private specIdOf(workflowId: string): number {
    const known = this.workflowIds.indexOf(workflowId);
    if (known !== -1) return known;
    this.workflowIds.push(workflowId);
    return this.workflowIds.length - 1;
  }

  private gatedD1(): Env["DB"] {
    const statementOf = (sql: string, params: unknown[]): GatedStatement => {
      const execute = <Result>(run: () => Result) => {
        const named = this.statementCall(sql, params);
        return this.gate.hold(named, () => inSpecOrderFor(named, run()));
      };
      return {
        sql,
        params,
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
      batch: (statements: GatedStatement[]) => {
        const [first] = statements;
        if (!first) throw new Error("the replay got an empty batch");
        return this.gate.hold(this.statementCall(first.sql, first.params), () =>
          this.sqlite.transaction(() =>
            statements.map(({ sql, params }) => {
              const changes = this.sqlite.query(sql).run(...sqliteParams(params)).changes;
              return { success: true, results: [], meta: { changes } };
            }),
          )(),
        );
      },
    };
    return binding as Env["DB"];
  }

  /** The call a D1 statement makes, as the spec names it. A new workflow id gets the next number. */
  private statementCall(sql: string, params: unknown[]): string {
    const ids = params
      .filter((param): param is string => typeof param === "string" && param.startsWith("wf_"))
      .map((workflowId) => this.specIdOf(workflowId));
    if (sql.startsWith('select distinct "workflows"."conversation_id"'))
      return FIND_PULL_CONVERSATIONS;
    if (sql.startsWith('select "definition" from "watches"')) return FIND_WATCHERS;
    if (sql.startsWith('select "workflows"."conversation_id" from "bindings"'))
      return `FindBoundConversation(${keyIn(params, BINDING_KEYS)})`;
    if (sql.startsWith('select "workflow_id" from "bindings"'))
      return `FindBinding(${keyIn(params, BINDING_KEYS)})`;
    if (/^select .* from "workflows"/.test(sql)) return `FindWorkflow(${ids[0]})`;
    if (sql.startsWith('insert into "conversations"'))
      return `RecordConversation(${keyIn(params, RECORDED_PLACES)})`;
    if (/^select .* from "conversations"/.test(sql))
      return `FindConversation(${keyIn(params, RECORDED_PLACES)})`;
    if (sql.startsWith('insert into "bindings"') && sql.includes("do nothing"))
      return `ClaimBinding(${keyIn(params, BINDING_KEYS)})`;
    if (sql.startsWith('update "bindings"')) return `ClaimBinding(${keyIn(params, BINDING_KEYS)})`;
    if (sql.startsWith('insert into "bindings"'))
      return `BindWorkflow(${keyIn(params, BINDING_KEYS)}, ${ids[0]})`;
    if (sql.startsWith('insert into "workflows"')) return `WriteWorkflowRow(${ids[0]})`;
    if (sql.startsWith('delete from "bindings"')) return `DeleteBindings(${ids[0]})`;
    throw new Error(`the replay does not name the statement ${sql}`);
  }
}

function required<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`the spec step did not pick a ${name}`);
  return value;
}

const FIND_PULL_CONVERSATIONS = "FindPullConversations";

const FIND_WATCHERS = "FindWatchers";

/**
 * The rows of a read in the order the spec hands the event to conversations: a base move's by
 * place, and the watchers by definition.
 */
function inSpecOrderFor<Result>(named: string, result: Result): Result {
  if (named === FIND_PULL_CONVERSATIONS) return inSpecOrder(result, conversationRank);
  if (named === FIND_WATCHERS) return inSpecOrder(result, watchDefinitionIndex);
  return result;
}

function inSpecOrder<Result>(result: Result, rankOf: (value: string) => number): Result {
  const byRank = (left: unknown, right: unknown) =>
    rankOf(firstColumn(left)) - rankOf(firstColumn(right));
  if (Array.isArray(result)) return result.toSorted(byRank) as Result;
  const results = itfList(itfField(result, "results")).toSorted(byRank);
  return { ...result, results };
}

function firstColumn(row: unknown): string {
  return itfText(Array.isArray(row) ? row[0] : Object.values(asRecord(row))[0]);
}

function conversationRank(conversationId: string): number {
  return PLACES.indexOf(placeOfConversation(conversationId));
}

function watchDefinitionIndex(definition: string): number {
  const index = WATCH_DEFINITIONS.findIndex((declared) => declared.name === definition);
  if (index === -1) throw new Error(`the replay does not know the definition ${definition}`);
  return index;
}

function placeOfConversation(conversationId: string): PlaceName {
  const place = PLACES.find((candidate) => CONVERSATION_IDS[candidate] === conversationId);
  if (!place) throw new Error(`the replay does not know the conversation ${conversationId}`);
  return place;
}

/** The spec name of the first source and external id pair among the params that `names` knows. */
function keyIn<Name extends string>(params: unknown[], names: Record<string, Name>): Name {
  for (const [index, param] of params.entries()) {
    const named = names[`${String(param)}:${String(params[index + 1])}`];
    if (named) return named;
  }
  throw new Error(`the replay does not know the key in ${JSON.stringify(params)}`);
}

function pullKeyOf(number: number): PullKeyName {
  const pull = PULL_KEYS.find((key) => PULL_NUMBERS[key] === number);
  if (!pull) throw new Error(`the replay does not know the pull request #${number}`);
  return pull;
}

function textOf(row: unknown, field: string): string {
  return itfText(itfField(row, field));
}

const ROUTER_STATUSES: readonly WorkflowStatus[] = [
  "running",
  "waiting_input",
  "done",
  "failed",
  "cancelled",
];

function workflowStatusOf(status: string): WorkflowStatusName {
  switch (status) {
    case "ending":
      return "Ending";
    case "ended":
      return "Done";
    default:
      return "Running";
  }
}
