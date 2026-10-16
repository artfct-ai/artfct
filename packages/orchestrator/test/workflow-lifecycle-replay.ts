import { setSystemTime } from "bun:test";
import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import type { TaskStatus, WorkflowStatus } from "@artfct-ai/contracts/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { planTools } from "../src/agent/tools/plan";
import { startTools } from "../src/agent/tools/start/start";
import { taskTools } from "../src/agent/tools/task";
import type { SandboxRef } from "../src/sandbox/spec";
import { jobInputKey } from "../src/workflow/store/input-key";
import { isTaskFinished } from "../src/workflow/store/state";
import type { JobRow, TaskRow } from "../src/workflow/store/tasks";
import type { ConnectionState } from "../src/workflow/task/harness/bridge";
import { onNoProgress } from "../src/workflow/task/harness/timers";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import { FakeSandboxProvider } from "./fake-sandbox";
import { InterleavedDecisions } from "./interleaved-decisions";
import {
  authorTurnEnds,
  firstArtifactAppears,
  personCancels,
  personWrites,
  staleAlarmFires,
  timerFires,
  workflowRestarts,
} from "./workflow-actions";
import {
  REPO,
  REQUEST_TEXTS,
  SECOND_DEFINITION,
  SLOTS,
  STAGE_OF,
  WorkflowWorld,
  type RefinerSetup,
  type StepFacts,
  type WorkflowAction,
  type WorldSetup,
} from "./workflow-world";

/** The setup modules of the workflow lifecycle spec, and the refiner list of each. */
export const SPEC_SETUPS = {
  pagesWithAReviewer: "reviewer",
  pagesWithoutRefiners: "none",
} as const satisfies Record<string, RefinerSetup>;

/** The name of one setup module of the spec. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

/** The most steps a generated trace takes after its initial state. */
export const TRACE_STEPS = 25;

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
const ARTIFACT_STATUSES = ["NoArtifact", "Drafted", "Ready"] as const;
const REFINER_RUN_STATUSES = ["NoRefinerRun", "RefinerRunning", "RefinerRunFinished"] as const;
const CALL_KINDS = ["SandboxDestroy", "AcceptanceCheck"] as const;
const ENDINGS = ["PersonCancels", "AgentFails", "AgentFinishes"] as const;

type CallKind = (typeof CALL_KINDS)[number];
type Ending = (typeof ENDINGS)[number];

/** The author task of one job as the spec sees it. */
export type SpecAuthor = {
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
  input: { from: "request"; request: number } | { from: "artifact"; job: number };
  author: SpecAuthor;
  artifact: (typeof ARTIFACT_STATUSES)[number];
  refinerRun: (typeof REFINER_RUN_STATUSES)[number];
};

/** One held call as the spec sees it, without the rest of the step that runs when it returns. */
export type SpecCall = { kind: CallKind; job: number };

/** The workflow as the spec sees it. */
export type SpecWorkflow = {
  status: (typeof WORKFLOW_STATUSES)[number];
  definition: number | null;
  idleArmed: boolean;
  jobs: SpecJob[];
  calls: SpecCall[];
};

/** The values the spec picked for one action. */
export type SpecPicks = {
  definition: number | null;
  request: number | null;
  id: number | null;
  callId: number | null;
  accepted: boolean | null;
  ending: Ending | null;
};

/** One state of a trace: the action that led to it, its picks, and the workflow. */
export type TraceStep = { action: string; picks: SpecPicks; workflow: SpecWorkflow };

/** Run the spec of one setup for `count` traces from `seed`. */
export function generateTraces(setup: SpecSetup, count: number, seed: number): TraceStep[][] {
  return quintTraces({ spec: "workflow-lifecycle", setup, count, steps: TRACE_STEPS, seed }).map(
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
    const accepted = picked("accepted");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        definition: optionalInt(picked("definition")),
        request: optionalInt(picked("request")),
        id: optionalInt(picked("id")),
        callId: optionalInt(picked("callId")),
        accepted: accepted === null ? null : itfBool(accepted),
        ending: ending === null ? null : itfOneOf(itfVariant(ending)!.tag, ENDINGS),
      },
      workflow: specWorkflow(itfField(state, `${setup}::workflowLifecycle::workflow`)),
    };
  });
}

function optionalInt(value: unknown): number | null {
  return value === null ? null : itfInt(value);
}

function specWorkflow(value: unknown): SpecWorkflow {
  const definition = itfVariant(itfField(value, "definition"))!;
  return {
    status: itfOneOf(itfVariant(itfField(value, "status"))!.tag, WORKFLOW_STATUSES),
    definition: definition.tag === "Planned" ? itfInt(definition.value) : null,
    idleArmed: itfBool(itfField(value, "idleArmed")),
    jobs: itfList(itfField(value, "jobs")).map(specJob),
    calls: itfList(itfField(value, "calls")).map((call) => ({
      kind: itfOneOf(itfVariant(itfField(call, "kind"))!.tag, CALL_KINDS),
      job: itfInt(itfField(call, "job")),
    })),
  };
}

function specJob(value: unknown): SpecJob {
  const input = itfVariant(itfField(value, "input"))!;
  const author = itfField(value, "author");
  return {
    input:
      input.tag === "FromRequest"
        ? { from: "request", request: itfInt(input.value) }
        : { from: "artifact", job: itfInt(input.value) },
    author: {
      status: itfOneOf(itfVariant(itfField(author, "status"))!.tag, TASK_STATUSES),
      restarts: itfInt(itfField(author, "restarts")),
      paused: itfBool(itfField(author, "paused")),
      turnRunning: itfBool(itfField(author, "turnRunning")),
      promptsSent: itfInt(itfField(author, "promptsSent")),
      promptsQueued: itfInt(itfField(author, "promptsQueued")),
      generationClosed: itfBool(itfField(author, "generationClosed")),
    },
    artifact: itfOneOf(itfVariant(itfField(value, "artifact"))!.tag, ARTIFACT_STATUSES),
    refinerRun: itfOneOf(itfVariant(itfField(value, "refinerRun"))!.tag, REFINER_RUN_STATUSES),
  };
}

/** One call the replay holds, with the step that waits on it. */
type HeldCall = {
  kind: CallKind;
  jobId: string;
  answer: (decisions: Decisions) => void;
  step: Promise<unknown> | null;
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

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const ACCEPTANCE = ["Looks good, ship it."];
const PAGE_APPROVED = "Review: approved\nReady as it stands.";
const STAGE = STAGE_OF.page;

const WORLD_SETUP: Omit<WorldSetup, "refiners"> = {
  opening: "request",
  artifact: "page",
  research: false,
  pageAuthor: "harness",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  origin: "chat",
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
 * maps to the entry point production uses. The destroy of an author sandbox and the acceptance
 * check of `complete_job` stay out until a later spec step returns them.
 */
export class WorkflowLifecycleReplay {
  private readonly calls: HeldCall[] = [];
  private stepOut: Promise<unknown> | null = null;
  private completingJobId = "";
  private heldArrived: (() => void) | null = null;
  private taken = 0;

  private constructor(readonly world: WorkflowWorld) {}

  /** A world on the refiner list of `setup`, before the plan. */
  static async open(setup: SpecSetup): Promise<WorkflowLifecycleReplay> {
    setSystemTime(new Date(REPLAY_START));
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, refiners: SPEC_SETUPS[setup] });
    const replay = new WorkflowLifecycleReplay(world);
    world.workflow.sandboxProvider = new HoldingSandboxProvider((taskId) =>
      replay.holdDestroy(taskId),
    );
    return replay;
  }

  /**
   * Take one spec action, then bring up every sandbox that waits. A new generation replaces the
   * bridge process of the old one, so the old socket closes first.
   */
  async take(step: TraceStep): Promise<void> {
    this.taken += 1;
    setSystemTime(new Date(REPLAY_START + this.taken * STEP_MS));
    this.world.workflow.gatewayInstance = new FakeGateway({
      decisions: new InterleavedDecisions(new FakeDecisions(ANSWERS), (questions) =>
        Object.hasOwn(questions.yesNo, "accepts") ? this.holdAcceptance() : null,
      ),
    });
    await this.world.apply(this.actionFor(step));
    await this.world.apply(
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
    await this.world.apply(
      worldAction("sandboxes come up", async (world) => {
        for (const task of world.tasksAwaitingSandbox()) await world.startSandboxOf(task.task_id);
      }),
    );
  }

  /** Return every held call and put the clock back. */
  async close(): Promise<void> {
    for (const call of this.calls.splice(0)) call.answer(new FakeDecisions(ANSWERS));
    setSystemTime();
  }

  /** The store as the spec sees it. */
  project(): SpecWorkflow {
    const { workflow } = this.world;
    const { store, state } = workflow;
    const jobs = store.jobs();
    const observed = this.world.steps.at(-1)?.after.tasks ?? [];
    return {
      status: WORKFLOW_STATUS_OF[state.status],
      definition: state.definition === null ? null : state.definition === SECOND_DEFINITION ? 1 : 0,
      idleArmed: workflow.alarmsFor("onIdle").length > 0,
      jobs: jobs.map((job) => {
        const author = store.authorOrResearcherTaskOf(job.job_id);
        const seen = observed.find((task) => task.task_id === author.task_id);
        const artifact = store.artifact(job.job_id);
        const runs = store.refinerRunsOf(job.job_id);
        return {
          input: this.inputOf(job, jobs),
          author: {
            status: SPEC_TASK_STATUS[author.status],
            restarts: author.restarts,
            paused: author.paused_at !== null,
            turnRunning: store.sandbox(author.task_id)?.prompt_in_flight === 1,
            promptsSent: seen ? seen.promptTexts.length - seen.queuedPrompts : 0,
            promptsQueued: seen?.queuedPrompts ?? 0,
            generationClosed:
              !isTaskFinished(author.status) &&
              workflow.connections(author.task_id).length === 0 &&
              !this.calls.some(
                (call) => call.kind === "SandboxDestroy" && call.jobId === job.job_id,
              ),
          },
          artifact: !artifact ? "NoArtifact" : artifact.status === "drafted" ? "Drafted" : "Ready",
          refinerRun:
            runs.length === 0
              ? "NoRefinerRun"
              : runs.some((run) => !isTaskFinished(run.status))
                ? "RefinerRunning"
                : "RefinerRunFinished",
        };
      }),
      calls: this.calls.map((call) => ({
        kind: call.kind,
        job: jobs.findIndex((job) => job.job_id === call.jobId),
      })),
    };
  }

  private inputOf(job: JobRow, jobs: JobRow[]): SpecJob["input"] {
    const built = jobs.findIndex((earlier) => job.input_key === `artifact:${earlier.job_id}`);
    if (built !== -1) return { from: "artifact", job: built };
    const request = REQUEST_TEXTS.findIndex(
      (requestText) => jobInputKey({ kind: "request", text: requestText }) === job.input_key,
    );
    return { from: "request", request };
  }

  private actionFor(step: TraceStep): WorkflowAction {
    const { picks } = step;
    switch (step.action) {
      case "agentSetsPlan":
        return worldAction(`agent sets the plan of definition ${picks.definition}`, (world) =>
          this.setPlan(world, required(picks.definition)),
        );
      case "agentStartsJob":
        return worldAction(`agent starts a job on request ${picks.request}`, async (world) => {
          const requestText = REQUEST_TEXTS[required(picks.request)] ?? REQUEST_TEXTS[0];
          const { start_job } = startTools(world.workflow, [requestText]);
          await start_job.execute({ stage: STAGE, brief: "Write the design." }, TOOL_CALL);
        });
      case "authorWritesItsPage":
        return worldAction(`author of job ${picks.id} writes its page`, async (world) => {
          const index = this.unfinishedIndexOf(required(picks.id));
          await firstArtifactAppears(index, "author_text").run(world);
          await authorTurnEnds(index, "same", "finished").run(world);
        });
      case "refinerRunEnds":
        return worldAction(`reviewer of job ${picks.id} approves`, (world) =>
          this.reviewerApproves(world, required(picks.id)),
        );
      case "agentPausesAuthor":
      case "agentResumesAuthor":
        return worldAction(`${step.action} of job ${picks.id}`, async (world) => {
          const call = step.action === "agentPausesAuthor" ? "pause_task" : "resume_task";
          const author = this.authorOf(required(picks.id));
          await taskTools(world.workflow)[call].execute({ task_id: author.task_id }, TOOL_CALL);
        });
      case "authorStalls":
        return worldAction(`author of job ${picks.id} stalls`, (world) =>
          this.authorStalls(world, required(picks.id)),
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
            this.completingJobId = this.jobOf(required(picks.id)).job_id;
            await complete_job.execute(
              { job_id: this.completingJobId, result: "Done." },
              TOOL_CALL,
            );
          }),
        );
      case "acceptanceCheckReturns":
        return worldAction(`acceptance check ${picks.callId} returns ${picks.accepted}`, () =>
          this.returnCall(required(picks.callId), required(picks.accepted) ? 0.9 : 0.1),
        );
      case "sandboxDestroyReturns":
        return worldAction(`sandbox destroy ${picks.callId} returns`, () =>
          this.returnCall(required(picks.callId), 0),
        );
      case "personWrites":
        return personWrites("prompt");
      case "workflowEnds":
        return worldAction(`the workflow ends: ${picks.ending}`, (world) =>
          this.runStep(() => this.endWorkflow(world, required(picks.ending))),
        );
      case "idleAlarmFires":
        return timerFires("idle", 0);
      case "staleAlarmFires":
        return staleAlarmFires("no_progress", 0);
      case "workflowRestarts":
        return worldAction("the workflow restarts", async (world) => {
          this.calls.length = 0;
          await workflowRestarts().run(world);
        });
      default:
        throw new Error(`no world action for spec action ${step.action}`);
    }
  }

  private async setPlan(world: WorkflowWorld, definition: number): Promise<StepFacts> {
    const name =
      definition === 1 ? SECOND_DEFINITION : (world.workflow.workflowDefinitions()[0]?.name ?? "");
    const { set_plan } = planTools(world.workflow);
    await set_plan.execute(
      {
        name: "Fix login",
        definition: name,
        reason: "the request asks for a design",
        stages: [STAGE],
        repo: REPO,
        page_parent: null,
        concurrency: SLOTS,
      },
      TOOL_CALL,
    );
    return { plan: { definition: name } };
  }

  private async endWorkflow(world: WorkflowWorld, ending: Ending): Promise<void> {
    switch (ending) {
      case "PersonCancels":
        await personCancels("control").run(world);
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

  private async reviewerApproves(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const run = world.workflow.store
      .refinerRunsOf(this.jobOf(jobIndex).job_id)
      .findLast((candidate) => !isTaskFinished(candidate.status));
    const bridge = run ? await world.bridgeWithRunningTurn(run.task_id) : null;
    if (!bridge) throw new Error(`the reviewer of job ${jobIndex} has no running turn`);
    world.answerDecisionsWith(ANSWERS);
    await bridge.say(PAGE_APPROVED);
    await bridge.endTurn("end_turn");
  }

  private async authorStalls(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const author = this.authorOf(jobIndex);
    const sandbox = world.workflow.store.requireSandbox(author.task_id);
    const alarm = { task_id: author.task_id, generation: sandbox.generation };
    if (!sandbox.nudged) await onNoProgress(world.workflow, alarm);
    await this.runStep(() => onNoProgress(world.workflow, alarm));
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

  private async returnCall(callId: number, accepts: number): Promise<void> {
    const [call] = this.calls.splice(callId, 1);
    if (!call) throw new Error(`no call ${callId} is out`);
    const rest = call.step;
    await this.runStep(async () => {
      call.answer(new FakeDecisions({ ...ANSWERS, accepts }));
      await rest;
    });
  }

  private holdDestroy(taskId: string): Promise<void> | null {
    const task = this.world.workflow.store.task(taskId);
    if (task?.role !== "author") return null;
    return new Promise<void>((release) => {
      this.hold({ kind: "SandboxDestroy", jobId: task.job_id, answer: () => release() });
    });
  }

  private holdAcceptance(): Promise<Decisions | null> {
    const jobId = this.completingJobId;
    return new Promise<Decisions | null>((release) => {
      this.hold({ kind: "AcceptanceCheck", jobId, answer: release });
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

  private authorOfJob(job: JobRow): TaskRow {
    return this.world.workflow.store.authorOrResearcherTaskOf(job.job_id);
  }

  private authorOf(jobIndex: number): TaskRow {
    return this.authorOfJob(this.jobOf(jobIndex));
  }

  /** The index `authorAt` counts the author of the job by, among the unfinished authors. */
  private unfinishedIndexOf(jobIndex: number): number {
    const taskId = this.authorOf(jobIndex).task_id;
    return this.world.authors
      .filter((author) => !isTaskFinished(this.world.taskOf(author).status))
      .findIndex((author) => author.taskId === taskId);
  }
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the spec action is missing a pick");
  return value;
}

const SPEC_TASK_STATUS: Record<TaskStatus, SpecAuthor["status"]> = {
  queued: "Busy",
  provisioning: "Busy",
  working: "Busy",
  in_review: "InReview",
  done: "TaskDone",
  cancelled: "TaskCancelled",
  failed: "TaskFailed",
};

const WORKFLOW_STATUS_OF: Record<WorkflowStatus, SpecWorkflow["status"]> = {
  new: "New",
  running: "Running",
  waiting_input: "WaitingInput",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
