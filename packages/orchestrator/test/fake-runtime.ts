import type { Chat, SessionStatus } from "@artfct-ai/adapters/chat/types";
import type { CodeHost } from "@artfct-ai/adapters/code/types";
import type { Decisions, Gateway } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeDocuments, type DocumentsAnswers } from "@artfct-ai/adapters/test/fake-documents";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { FakeWeb } from "@artfct-ai/adapters/test/fake-web";
import { MockHarness } from "@artfct-ai/adapters/test/mock-harness";
import type { Harness, HarnessAdapter } from "@artfct-ai/adapters/harness/types";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { Web } from "@artfct-ai/adapters/web/types";
import type { ArtifactKind, ArtifactStatus } from "@artfct-ai/contracts/types";
import { artifact } from "../src/clients";
import type { Artifact } from "../src/artifact/types";
import type { Config } from "../src/config/config";
import { orchestratorGateway, type GatewayProvider } from "../src/config/gateway";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { RefinerEntry, ReviewerEntry } from "../src/config/refiner";
import { resolveStage, type ResolvedStage } from "../src/config/stage";
import type { TaskEvent, TaskRole } from "../src/workflow/task/events";
import type { Connection } from "agents";
import type { JSONValue, LanguageModel, ToolSet } from "ai";
import { TranscriptStore } from "../src/agent/transcript/transcript";
import { registeredConfig } from "../src/config/register-config";
import type { WorkflowDefinition } from "../src/config/workflow-definition";
import type { Env } from "../src/env";
import { destinationFor } from "../src/notify/destination";
import { plainText } from "../src/notify/messages";
import { Notifier, type PostOptions } from "../src/notify/notifier";
import type { SandboxProvider } from "../src/sandbox/provider";
import { FakeSandboxProvider } from "./fake-sandbox";
import type { ConnectionState } from "../src/workflow/task/harness/bridge";
import type { WorkflowDb } from "../src/workflow/store/db";
import {
  initialWorkflowState,
  isWorkflowFinished,
  type WorkflowState,
} from "../src/workflow/store/state";
import {
  WorkflowStore,
  type JobRow,
  type NewJob,
  type SandboxRow,
  type TaskRow,
} from "../src/workflow/store/tasks";
import type { ScheduledMethod, Wake, WorkflowRuntime } from "../src/workflow/types";

export type FakeNote = { text: string; wake: Wake };

/** One armed alarm. A repeating alarm stays armed after it fires, until code stops it. */
export type FakeAlarm = {
  id: string;
  delay: number;
  method: ScheduledMethod;
  payload: unknown;
  repeats: boolean;
};

export type FakeClose = { code: number; reason: string };

export type FakeSocket = { connection: Connection; sent: string[]; closes: FakeClose[] };

let socketSeq = 0;

export function fakeConnection(
  taskId: string,
  generation: number,
  readyState: number = WebSocket.OPEN,
): FakeSocket {
  const state: ConnectionState = { task_id: taskId, generation };
  const sent: string[] = [];
  const closes: FakeClose[] = [];
  socketSeq += 1;
  const id = `socket-${taskId}-${socketSeq}`;
  const socket: WebSocket = Object.create(WebSocket.prototype);
  Object.defineProperty(socket, "readyState", { value: readyState });
  const connection: Connection = Object.assign(socket, {
    id,
    uri: null,
    state,
    setState: (next: unknown) => {
      const value =
        typeof next === "function" ? (next as (prev: unknown) => unknown)(connection.state) : next;
      connection.state = value as Connection["state"];
      return connection.state;
    },
    tags: [id],
    send: (data: string | ArrayBuffer | ArrayBufferView) => {
      sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    close: (code?: number, reason?: string) => {
      closes.push({ code: code ?? 1005, reason: reason ?? "" });
    },
  });
  return { connection, sent, closes };
}

export function sentMethods(socket: FakeSocket): (string | undefined)[] {
  return socket.sent.map((frame) => (JSON.parse(frame) as { method?: string }).method);
}

export class FakeRuntime implements WorkflowRuntime {
  env: Env;
  state: WorkflowState = { ...initialWorkflowState, workflow_id: "wf_x", status: "running" };
  readonly store: WorkflowStore;
  notifier: Notifier;
  readonly transcript: TranscriptStore;
  sandboxProvider: FakeSandboxProvider = new FakeSandboxProvider();
  alarms: FakeAlarm[] = [];
  cancelled: string[] = [];
  sockets: Connection[] = [];
  posted: TaskEvent[] = [];
  released: Array<ReplyTarget | null> = [];
  statuses: string[] = [];
  /**
   * The session status the notifier would leave on a chat thread after the posts, releases, and
   * working calls so far. Null before any of them.
   */
  chatSession: SessionStatus | null = null;
  notes: FakeNote[] = [];
  lines: string[] = [];
  gatewayInstance: Gateway | null = null;
  gatewayRequests: GatewayProvider[] = [];
  harnessInstance: HarnessAdapter | null = null;
  codeHostInstance: CodeHost | null = null;
  chatInstance: Chat | null = null;
  trackerInstance: Tracker | null = null;
  documentsInstance: Documents | null = null;
  webInstance: Web = new FakeWeb();
  mcpCredentialValue: string | null = null;
  mcpToolSet: ToolSet = {};
  modelInstance: LanguageModel | null = null;
  modelsByName: Record<string, LanguageModel> = {};
  modelRequests: (string | undefined)[] = [];
  modelParams: Record<string, JSONValue>[] = [];
  modelGateways: (GatewayProvider | undefined)[] = [];
  clock: number | null = null;
  turnRunning = false;
  configOverride: Config | null = null;
  workflowDefinitionOverride: WorkflowDefinition | null = null;
  private alarmSeq = 0;

  constructor(db: WorkflowDb, env: Env) {
    this.env = env;
    this.store = new WorkflowStore(db);
    this.transcript = new TranscriptStore(db);
    this.notifier = new Notifier(
      { tracker: async () => null, chat: null, documents: async () => null },
      (entry) => this.store.writeOutbox(entry),
    );
  }

  patchState(patch: Partial<WorkflowState>): void {
    this.state = { ...this.state, ...patch };
  }

  config(): Config {
    return this.configOverride ?? registeredConfig().config;
  }

  patchConfig(patch: Partial<Config>): Config {
    this.configOverride = { ...this.config(), ...patch };
    return this.configOverride;
  }

  workflowDefinition(): WorkflowDefinition {
    return this.workflowDefinitionOverride ?? registeredConfig().workflowDefinition;
  }

  patchWorkflowDefinition(patch: Partial<WorkflowDefinition>): void {
    this.workflowDefinitionOverride = { ...this.workflowDefinition(), ...patch };
  }

  stageFor(job: JobRow): ResolvedStage {
    return resolveStage(this.config(), this.stageDefinition(job));
  }

  stageForTask(task: TaskRow): ResolvedStage {
    return this.stageFor(this.store.requireJob(task.job_id));
  }

  private stageDefinition(job: JobRow) {
    const stage = this.workflowDefinition().stages.find((declared) => declared.name === job.stage);
    if (!stage)
      throw new Error(`Stage ${job.stage} of job ${job.job_id} is not in the workflow definition.`);
    return stage;
  }

  async scheduleAlarm(delay: number, method: ScheduledMethod, payload: unknown): Promise<string> {
    return this.armAlarm({ delay, method, payload, repeats: false });
  }

  async cancelAlarm(id: string): Promise<void> {
    this.cancelled.push(id);
    this.alarms = this.alarms.filter((alarm) => alarm.id !== id);
  }

  async startRepeatingAlarm(
    everySeconds: number,
    method: ScheduledMethod,
    payload: unknown,
  ): Promise<void> {
    if (this.repeatingAlarm(method, payload)) return;
    this.armAlarm({ delay: everySeconds, method, payload, repeats: true });
  }

  async stopRepeatingAlarm(method: ScheduledMethod, payload: unknown): Promise<void> {
    const repeating = this.repeatingAlarm(method, payload);
    if (repeating) await this.cancelAlarm(repeating.id);
  }

  private armAlarm(alarm: Omit<FakeAlarm, "id">): string {
    this.alarmSeq += 1;
    const id = `alarm-${this.alarmSeq}`;
    this.alarms.push({ id, ...alarm });
    return id;
  }

  private repeatingAlarm(method: ScheduledMethod, payload: unknown): FakeAlarm | undefined {
    const wanted = JSON.stringify(payload);
    return this.alarms.find(
      (alarm) =>
        alarm.repeats && alarm.method === method && JSON.stringify(alarm.payload) === wanted,
    );
  }

  async cancelAllAlarms(): Promise<void> {
    this.alarms = [];
  }

  async destroy(): Promise<void> {}

  connections(taskId?: string): Connection[] {
    if (!taskId) return this.sockets;
    return this.sockets.filter(
      (socket) => (socket.state as ConnectionState | null)?.task_id === taskId,
    );
  }

  log(taskId: string | null, line: string): void {
    this.lines.push(line);
    this.store.appendLog(taskId, line);
  }

  async post(event: TaskEvent, only?: ReplyTarget, options: PostOptions = {}): Promise<void> {
    this.posted.push(event);
    if (destinationFor(event) !== "channel") return;
    const targets = only ? [only] : this.state.reply_targets;
    for (const target of targets) await this.notifier.post(target, event, options);
    if (!plainText(event) || options.keepSession) return;
    this.chatSession = this.sessionAfterTurn();
  }

  async release(only?: ReplyTarget): Promise<void> {
    this.released.push(only ?? null);
    this.chatSession = this.sessionAfterTurn();
  }

  async working(text: string): Promise<void> {
    this.statuses.push(text);
    this.chatSession = "processing";
  }

  private sessionAfterTurn(): SessionStatus {
    return isWorkflowFinished(this.state.status) ? "closed" : "active";
  }

  gateway(provider: GatewayProvider): Gateway | null {
    this.gatewayRequests.push(provider);
    return this.gatewayInstance;
  }

  decisions(): Decisions | null {
    const config = this.config();
    return (
      this.gateway(orchestratorGateway(config))?.decisions(config.orchestrator.decisions_model) ??
      null
    );
  }

  harness(name: Harness): HarnessAdapter {
    return this.harnessInstance ?? new MockHarness(name);
  }

  code(): CodeHost | null {
    return this.codeHostInstance;
  }

  chat(): Chat | null {
    return this.chatInstance;
  }

  async tracker(): Promise<Tracker | null> {
    return this.trackerInstance;
  }

  async documents(): Promise<Documents | null> {
    return this.documentsInstance;
  }

  web(): Web {
    return this.webInstance;
  }

  async mcpCredential(): Promise<string | null> {
    return this.mcpCredentialValue;
  }

  artifact(kind: ArtifactKind): Artifact {
    return artifact(kind, {
      adapters: this.config().adapters,
      code: () => this.code(),
      documents: () => this.documents(),
      repo: () => this.state.repo?.full ?? null,
      log: (line) => this.log(null, line),
    });
  }

  sandbox(): SandboxProvider {
    return this.sandboxProvider;
  }

  agentTurnRunning(): boolean {
    return this.turnRunning;
  }

  async tellAgent(text: string, wake: Wake): Promise<void> {
    this.notes.push({ text, wake });
  }

  async model(
    modelName?: string,
    params?: Record<string, JSONValue>,
    gateway?: GatewayProvider,
  ): Promise<LanguageModel> {
    this.modelRequests.push(modelName);
    this.modelParams.push(params ?? {});
    this.modelGateways.push(gateway);
    const named = modelName ? this.modelsByName[modelName] : undefined;
    const model = named ?? this.modelInstance;
    if (!model) throw new Error("the fake runtime has no model. Set modelInstance.");
    return model;
  }

  mcpTools(): Promise<ToolSet> {
    return Promise.resolve(this.mcpToolSet);
  }

  now(): number {
    return this.clock ?? Date.now();
  }

  alarmsFor(method: ScheduledMethod): FakeAlarm[] {
    return this.alarms.filter((alarm) => alarm.method === method);
  }

  noteTexts(): string[] {
    return this.notes.map((note) => note.text);
  }
}

/** A task row patch, with the fields of the job the seeded task belongs to. */
export type SeedTaskPatch = Partial<TaskRow> & Partial<NewJob>;

/** The job id a seeded task belongs to unless the patch names one: `wf_x.3` belongs to `wf_x-3`. */
export function seedJobId(taskId: string): string {
  return taskId.replace(/\.(\d+)$/, "-$1");
}

export function seedTask(
  workflow: FakeRuntime,
  patch: SeedTaskPatch = {},
  sandbox: Partial<SandboxRow> = {},
): TaskRow {
  const {
    stage,
    issue_id,
    issue_key,
    input_key,
    preceding_job_id,
    input_ref,
    input_url,
    branch,
    brief,
    ...taskPatch
  } = patch;
  const taskId = taskPatch.task_id ?? "wf_x.1";
  const jobId = taskPatch.job_id ?? seedJobId(taskId);
  if (!workflow.store.job(jobId)) {
    workflow.store.insertJob({
      job_id: jobId,
      stage: stage ?? "design",
      issue_id: issue_id ?? null,
      issue_key: issue_key ?? null,
      input_key: input_key ?? issue_id ?? null,
      preceding_job_id: preceding_job_id ?? null,
      input_ref: input_ref ?? null,
      input_url: input_url ?? null,
      branch: branch ?? null,
      brief: brief ?? "",
    });
  }
  workflow.store.insertTask({
    task_id: taskId,
    job_id: jobId,
    role: "author",
    sandbox: { harness: "opencode", bridge_token: "tok" },
    model: "mock",
  });
  workflow.store.updateTask(taskId, { status: "working", ...taskPatch });
  workflow.store.updateSandbox(taskId, { generation: 1, ...sandbox });
  const sequence = Number(taskId.split(".").at(-1));
  if (Number.isFinite(sequence) && sequence > workflow.state.task_seq) {
    workflow.patchState({ task_seq: sequence });
  }
  if (Number.isFinite(sequence) && sequence > (workflow.state.job_seq ?? 0)) {
    workflow.patchState({ job_seq: sequence });
  }
  return workflow.store.requireTask(taskId);
}

export type SeedArtifact = { status?: ArtifactStatus; refiner_task_id?: string; number?: number };

export function seedPullRequestTask(
  workflow: FakeRuntime,
  patch: SeedTaskPatch = {},
  seed: SeedArtifact = {},
): TaskRow {
  workflow.patchState({ repo: { full: "acme/app" } });
  const task = seedTask(workflow, { stage: "implement", branch: "artfct/wf_x-1-fix", ...patch });
  const number = seed.number ?? 1;
  workflow.store.upsertArtifact({
    job_id: task.job_id,
    kind: "pull",
    external_url: `https://github.com/acme/app/pull/${number}`,
    ref: { kind: "pull", repo: "acme/app", number },
  });
  if (seed.status && seed.status !== "drafted") {
    workflow.store.advanceArtifact(task.job_id, ["drafted"], seed.status);
  }
  if (seed.refiner_task_id) {
    workflow.store.setArtifactRefinerRun(task.job_id, seed.refiner_task_id);
  }
  return workflow.store.requireTask(task.task_id);
}

export function seedIssuesTask(
  workflow: FakeRuntime,
  patch: SeedTaskPatch = {},
  seed: SeedArtifact = {},
): TaskRow {
  const task = seedTask(workflow, { stage: "breakdown", ...patch });
  workflow.store.upsertArtifact({
    job_id: task.job_id,
    kind: "issues",
    external_url: "https://linear.app/acme/issue/ENG-42",
    ref: { kind: "issues" },
  });
  if (seed.status && seed.status !== "drafted") {
    workflow.store.advanceArtifact(task.job_id, ["drafted"], seed.status);
  }
  if (seed.refiner_task_id) {
    workflow.store.setArtifactRefinerRun(task.job_id, seed.refiner_task_id);
  }
  return workflow.store.requireTask(task.task_id);
}

export const REVIEW_AUTHOR = "wf_x.1";
export const REVIEW_JOB = "wf_x-1";
export const REVIEW_TASK = "wf_x.2";

/** A reviewer over the pull request of `REVIEW_JOB`. `job` sets fields of the job, such as its issue. */
export function seedReviewerRun(workflow: FakeRuntime, job: Partial<NewJob> = {}): TaskRow {
  return seedRefinerRun(workflow, { role: "reviewer", index: 0, job });
}

/**
 * A polisher over the pull request of `REVIEW_JOB`, at the refiner index after the stage's one
 * reviewer. The caller declares the polisher list with `patchStagePolishers`.
 */
export function seedPolisherRun(workflow: FakeRuntime): TaskRow {
  return seedRefinerRun(workflow, { role: "polisher", index: 1, job: {} });
}

function seedRefinerRun(
  workflow: FakeRuntime,
  { role, index, job }: { role: TaskRole; index: number; job: Partial<NewJob> },
): TaskRow {
  seedPullRequestTask(
    workflow,
    { task_id: REVIEW_AUTHOR, ...job },
    { refiner_task_id: REVIEW_TASK },
  );
  workflow.store.insertTask({
    task_id: REVIEW_TASK,
    job_id: REVIEW_JOB,
    role,
    refiner_index: index,
    sandbox: { harness: "opencode", bridge_token: "tok" },
    model: "mock",
  });
  return workflow.store.requireTask(REVIEW_TASK);
}

/** Replace the reviewer list of every stage, so a test can shrink or grow the refiners. */
export function patchStageReviewers(workflow: FakeRuntime, reviewers: ReviewerEntry[]): void {
  workflow.patchWorkflowDefinition({
    stages: workflow.workflowDefinition().stages.map((stage) => ({ ...stage, reviewers })),
  });
}

/** Replace the polisher list of every stage, so a test can run refiners that change the artifact. */
export function patchStagePolishers(workflow: FakeRuntime, polishers: RefinerEntry[]): void {
  workflow.patchWorkflowDefinition({
    stages: workflow.workflowDefinition().stages.map((stage) => ({ ...stage, polishers })),
  });
}

/** Give every stage a research step on the mock harness, so a researcher runs before each author. */
export function patchStageResearch(workflow: FakeRuntime): void {
  const research = { skill: "research", harness: "opencode" as const, model: "mock" };
  workflow.patchWorkflowDefinition({
    stages: workflow.workflowDefinition().stages.map((stage) => ({ ...stage, research })),
  });
}

/** The gateway model id a model-call author produces on in tests. */
export const MODEL_AUTHOR_MODEL = "openrouter/x-ai/grok-4.6";

/** The page parent a test plan names. */
export const PAGE_PARENT = "project-1";

/** Run the author of every stage as a model-call task on a fake document host. */
export function patchModelExecution(workflow: FakeRuntime): FakeDocuments {
  workflow.patchState({ page_parent: PAGE_PARENT });
  workflow.patchWorkflowDefinition({
    stages: workflow.workflowDefinition().stages.map((stage) => ({
      ...stage,
      author: {
        produce: {
          execution: "model" as const,
          model: MODEL_AUTHOR_MODEL,
          effort: stage.author.produce.effort,
          skill: stage.author.produce.skill,
          preload_skills: [],
        },
      },
    })),
  });
  const documents = new FakeDocuments();
  workflow.documentsInstance = documents;
  return documents;
}

/**
 * Run every author as a model call on a fake host that nests pages, with the design stage
 * making the root page.
 */
export function patchNestingHost(
  workflow: FakeRuntime,
  answers: DocumentsAnswers = {},
): FakeDocuments {
  patchModelExecution(workflow);
  const definition = workflow.workflowDefinition();
  workflow.patchWorkflowDefinition({ documents: { ...definition.documents, root_page: "design" } });
  const host = new FakeDocuments({ ...answers, nests: true });
  workflow.documentsInstance = host;
  return host;
}

/** The fake document host the runtime holds. */
export function fakeDocumentsOf(workflow: FakeRuntime): FakeDocuments {
  const documents = workflow.documentsInstance;
  if (!(documents instanceof FakeDocuments)) throw new Error("the runtime holds no FakeDocuments");
  return documents;
}

/** A queued model-call author task `wf_x.1` of job `wf_x-1`. */
export function seedModelAuthor(workflow: FakeRuntime, job: Partial<NewJob> = {}): TaskRow {
  workflow.store.insertJob({
    job_id: "wf_x-1",
    stage: "design",
    issue_id: null,
    issue_key: null,
    input_key: null,
    preceding_job_id: null,
    branch: null,
    brief: "",
    ...job,
  });
  workflow.store.insertTask({
    task_id: "wf_x.1",
    job_id: job.job_id ?? "wf_x-1",
    role: "author",
    model: MODEL_AUTHOR_MODEL,
    sandbox: null,
  });
  workflow.patchState({ task_seq: 1, job_seq: 1 });
  return workflow.store.requireTask("wf_x.1");
}

/** A judge reviewer entry, for a test of a list with a segment boundary or of a ruling. */
export const JUDGE_ENTRY: ReviewerEntry = {
  name: "alignment",
  mode: "judge",
  skill: "implement-approach-judge",
  rejects_when: {
    question: "Does `conclusion` say the approach is wrong?",
    yes: "It asks for a rewrite.",
    no: "It says the approach holds.",
  },
};

/** What a judge reviewer's turn ends with, so a test can set it as the task summary. */
export const JUDGE_CONCLUSION = "I read the diff.\n## Conclusion\nThe approach holds.";

/** Give the runtime a decisions model that answers every ruling with `rejects`, or fails. */
export function stubRulingModel(workflow: FakeRuntime, rejects: number | Error): FakeDecisions {
  const decisions = new FakeDecisions(rejects instanceof Error ? rejects : { rejects });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}
