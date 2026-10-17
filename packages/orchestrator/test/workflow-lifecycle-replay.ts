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
import { startTools } from "../src/agent/tools/start/start";
import { CLOSING_TEXT_MARKER } from "../src/prompts/model-author-prompt";
import { taskTools } from "../src/agent/tools/task";
import type { SandboxRef } from "../src/sandbox/spec";
import { jobInputKey } from "../src/workflow/store/input-key";
import { isTaskFinished } from "../src/workflow/store/state";
import type { JobRow, TaskRow } from "../src/workflow/store/tasks";
import type { ConnectionState } from "../src/workflow/task/harness/bridge";
import { onNoProgress } from "../src/workflow/task/harness/timers";
import { onModelTurnDeadline, type ModelTurnAlarm } from "../src/workflow/task/model-turn";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import { EchoModel } from "./fake-model";
import { MODEL_AUTHOR_MODEL, PAGE_PARENT } from "./fake-runtime";
import { FakeSandboxProvider } from "./fake-sandbox";
import { InterleavedDecisions } from "./interleaved-decisions";
import type { Step } from "./invariants";
import {
  authorTurnEnds,
  firstArtifactAppears,
  GENERATION_TIMERS,
  personCancels,
  personWrites,
  researcherTurnEnds,
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
  type StepFacts,
  type WorkflowAction,
  type WorldSetup,
} from "./workflow-world";

/** The setup modules of the workflow lifecycle spec, and the stage each one runs. */
export const SPEC_SETUPS = {
  pagesWithAReviewer: { refiners: "reviewer", pageAuthor: "harness", research: false },
  pagesWithoutRefiners: { refiners: "none", pageAuthor: "harness", research: false },
  pagesAfterResearch: { refiners: "none", pageAuthor: "harness", research: true },
  pagesFromModelCalls: { refiners: "none", pageAuthor: "model", research: false },
} as const satisfies Record<string, Pick<WorldSetup, "refiners" | "pageAuthor" | "research">>;

/** The name of one setup module of the spec. */
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
const ARTIFACT_STATUSES = ["NoArtifact", "Drafted", "Ready"] as const;
const REFINER_RUN_STATUSES = ["NoRefinerRun", "RefinerRunning", "RefinerRunFinished"] as const;
const CALL_KINDS = ["SandboxDestroy", "AcceptanceCheck", "ModelCall"] as const;
const ROLES = ["Researcher", "Author"] as const;
const JOB_ROLES: readonly TaskRow["role"][] = ["researcher", "author"];
const ENDINGS = ["PersonCancels", "AgentFails", "AgentFinishes"] as const;

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
type Ending = (typeof ENDINGS)[number];
type GenerationTimer = (typeof GENERATION_TIMERS)[number];

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
  input: { from: "request"; request: number } | { from: "artifact"; job: number };
  tasks: SpecTask[];
  artifact: (typeof ARTIFACT_STATUSES)[number];
  refinerRun: (typeof REFINER_RUN_STATUSES)[number];
};

/** One held call as the spec sees it, without the rest of the step that runs when it returns. */
type SpecCall = { kind: CallKind; job: number };

/** The workflow as the spec sees it. */
export type SpecWorkflow = {
  status: (typeof WORKFLOW_STATUSES)[number];
  definition: number | null;
  stagesPlanned: boolean;
  movedATrackerIssue: boolean;
  idleArmed: boolean;
  jobs: SpecJob[];
  calls: SpecCall[];
  failuresPosted: number;
};

/** The values the spec picked for one action. */
type SpecPicks = {
  definition: number | null;
  withStages: boolean | null;
  timer: GenerationTimer | null;
  sandbox: number | null;
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
    const withStages = picked("withStages");
    const timer = picked("timer");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        definition: optionalInt(picked("definition")),
        withStages: withStages === null ? null : itfBool(withStages),
        timer:
          timer === null
            ? null
            : GENERATION_TIMER_OF[itfOneOf(itfVariant(timer)!.tag, SPEC_TIMERS)],
        sandbox: optionalInt(picked("sandbox")),
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
    stagesPlanned: itfBool(itfField(value, "stagesPlanned")),
    movedATrackerIssue: itfBool(itfField(value, "movedATrackerIssue")),
    idleArmed: itfBool(itfField(value, "idleArmed")),
    jobs: itfList(itfField(value, "jobs")).map(specJob),
    calls: itfList(itfField(value, "calls")).map((call) => ({
      kind: itfOneOf(itfVariant(itfField(call, "kind"))!.tag, CALL_KINDS),
      job: itfInt(itfField(call, "job")),
    })),
    failuresPosted: itfInt(itfField(value, "failuresPosted")),
  };
}

function specJob(value: unknown): SpecJob {
  const input = itfVariant(itfField(value, "input"))!;
  return {
    input:
      input.tag === "FromRequest"
        ? { from: "request", request: itfInt(input.value) }
        : { from: "artifact", job: itfInt(input.value) },
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
    refinerRun: itfOneOf(itfVariant(itfField(value, "refinerRun"))!.tag, REFINER_RUN_STATUSES),
  };
}

/**
 * One call the replay holds, with the step that waits on it. A model call names the model turn
 * that made it, and the task when that turn revises its page.
 */
type HeldCall = {
  kind: CallKind;
  jobId: string;
  answer: (decisions: Decisions) => void;
  step: Promise<unknown> | null;
  turnId: string | null;
  revisedBy: string | null;
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

/** A page model that holds each call until the replay returns it, then answers with a new page. */
class HoldingPageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "holding-page";
  readonly supportedUrls = {};

  constructor(private readonly hold: () => Promise<string>) {}

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    return new EchoModel(await this.hold()).doGenerate(options);
  }

  async doStream(_options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };
const ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const ACCEPTANCE = ["Looks good, ship it."];
const PAGE_APPROVED = "Review: approved\nReady as it stands.";
const STAGE = STAGE_OF.page;

const WORLD_SETUP: Omit<WorldSetup, "refiners" | "pageAuthor" | "research"> = {
  opening: "request",
  artifact: "page",
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

  private constructor(
    readonly world: WorkflowWorld,
    private readonly modelAuthor: boolean,
  ) {}

  /** A world on the stage of `setup`, before the plan. */
  static async open(setup: SpecSetup): Promise<WorkflowLifecycleReplay> {
    setSystemTime(new Date(REPLAY_START));
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, ...SPEC_SETUPS[setup] });
    const modelAuthor = SPEC_SETUPS[setup].pageAuthor === "model";
    const replay = new WorkflowLifecycleReplay(world, modelAuthor);
    world.workflow.sandboxProvider = new HoldingSandboxProvider((taskId) =>
      replay.holdDestroy(taskId),
    );
    if (modelAuthor) {
      world.workflow.modelsByName[MODEL_AUTHOR_MODEL] = new HoldingPageModel(() =>
        replay.holdModelCall(),
      );
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
    setSystemTime(new Date(REPLAY_START + this.taken * STEP_MS));
    this.world.workflow.gatewayInstance = new FakeGateway({
      decisions: new InterleavedDecisions(new FakeDecisions(ANSWERS), (questions) =>
        Object.hasOwn(questions.yesNo, "accepts") ? this.holdAcceptance() : null,
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
      stagesPlanned: state.stages.length > 0,
      movedATrackerIssue: this.world.steps.some((step) => step.issueUpdates > 0),
      idleArmed: workflow.alarmsFor("onIdle").length > 0,
      jobs: jobs.map((job) => {
        const artifact = store.artifact(job.job_id);
        const runs = store.refinerRunsOf(job.job_id);
        return {
          input: this.inputOf(job, jobs),
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
      failuresPosted: workflow.posted.filter((event) => event.type === "failed").length,
    };
  }

  /**
   * The prompts of a model-call author as the spec counts them. A revise turn sends its prompt
   * as it starts, and that prompt stays queued until the turn applies its revision.
   */
  private modelTurnsOf(
    task: TaskRow,
  ): Pick<SpecTask, "turnRunning" | "promptsSent" | "promptsQueued" | "generationClosed"> {
    const queued = this.world.workflow.store
      .queue()
      .filter((row) => row.task_id === task.task_id).length;
    const revising =
      !isTaskFinished(task.status) &&
      this.calls.some((call) => call.kind === "ModelCall" && call.revisedBy === task.task_id);
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
          (world) => this.setPlan(world, required(picks.definition), required(picks.withStages)),
        );
      case "agentStartsJob":
        return worldAction(`agent starts a job on request ${picks.request}`, async (world) => {
          const requestText = REQUEST_TEXTS[required(picks.request)] ?? REQUEST_TEXTS[0];
          const { start_job } = startTools(world.workflow, [requestText]);
          await start_job.execute({ stage: STAGE, brief: "Write the design." }, TOOL_CALL);
        });
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
      case "refinerRunEnds":
        return worldAction(`reviewer of job ${picks.id} approves`, (world) =>
          this.reviewerApproves(world, required(picks.id)),
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
      case "modelCallReturns":
        return worldAction(`model call ${picks.callId} returns`, () =>
          this.returnCall(required(picks.callId), 0),
        );
      case "modelTurnOutlivesItsDeadline":
        return worldAction(`the deadline of model call ${picks.callId} passes`, (world) =>
          this.modelTurnOutlivesItsDeadline(world, required(picks.callId)),
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
        return staleAlarmFires(required(picks.timer), required(picks.sandbox));
      case "workflowRestarts":
        return worldAction("the workflow restarts", (world) => this.restart(world));
      default:
        throw new Error(`no world action for spec action ${step.action}`);
    }
  }

  private async setPlan(
    world: WorkflowWorld,
    definition: number,
    withStages: boolean,
  ): Promise<StepFacts> {
    const name =
      definition === 2
        ? UNDECLARED_DEFINITION
        : definition === 1
          ? SECOND_DEFINITION
          : (world.workflow.workflowDefinitions()[0]?.name ?? "");
    const stages = {
      stages: [STAGE],
      repo: REPO,
      page_parent: this.modelAuthor ? PAGE_PARENT : null,
      concurrency: SLOTS,
    };
    const { set_plan } = planTools(world.workflow);
    await set_plan.execute(
      {
        name: "Fix login",
        definition: name,
        reason: "the request asks for a design",
        ...(withStages ? stages : {}),
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

  private async taskStalls(world: WorkflowWorld, jobIndex: number): Promise<void> {
    const task = this.taskOf(jobIndex);
    const sandbox = world.workflow.store.requireSandbox(task.task_id);
    const alarm = { task_id: task.task_id, generation: sandbox.generation };
    if (!sandbox.nudged) await onNoProgress(world.workflow, alarm);
    await this.runStep(() => onNoProgress(world.workflow, alarm));
  }

  /**
   * The Durable Object restarts and every held call is lost. Each model turn the start step arms
   * for now resumes in its own step, so a resumed turn whose model call is held does not hold
   * the next one back.
   */
  private async restart(world: WorkflowWorld): Promise<void> {
    this.calls.length = 0;
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

  /** The deadline of a held model call fires first. The call never answers. */
  private async modelTurnOutlivesItsDeadline(world: WorkflowWorld, callId: number): Promise<void> {
    const [call] = this.calls.splice(callId, 1);
    if (!call?.turnId) throw new Error(`no model call ${callId} is out`);
    const deadline = world.workflow
      .alarmsFor("onModelTurnDeadline")
      .find((alarm) => (alarm.payload as ModelTurnAlarm).turn_id === call.turnId);
    if (!deadline) throw new Error(`model turn ${call.turnId} has no deadline armed`);
    await world.workflow.cancelAlarm(deadline.id);
    await this.runStep(() =>
      onModelTurnDeadline(world.workflow, deadline.payload as ModelTurnAlarm),
    );
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
      this.hold({
        kind: "SandboxDestroy",
        jobId: task.job_id,
        answer: () => release(),
        turnId: null,
        revisedBy: null,
      });
    });
  }

  private holdAcceptance(): Promise<Decisions | null> {
    const jobId = this.completingJobId;
    return new Promise<Decisions | null>((release) => {
      this.hold({ kind: "AcceptanceCheck", jobId, answer: release, turnId: null, revisedBy: null });
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

const WORKFLOW_STATUS_OF: Record<WorkflowStatus, SpecWorkflow["status"]> = {
  new: "New",
  running: "Running",
  waiting_input: "WaitingInput",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
