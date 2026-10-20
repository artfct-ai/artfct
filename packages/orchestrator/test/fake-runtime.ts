import type { Chat, SessionStatus } from "@artfct-ai/adapters/chat/types";
import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
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
import type { McpCapability } from "../src/config/adapters";
import type { Config } from "../src/config/config";
import { orchestratorGateway, type GatewayProvider } from "../src/config/gateway";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { RefinerEntry, ReviewerEntry } from "../src/config/refiner";
import { resolveStage, type ResolvedStage } from "../src/config/stage";
import type { TaskEvent, TaskRole } from "../src/workflow/task/events";
import type { Connection } from "agents";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { JSONValue, ToolSet } from "ai";
import { TranscriptStore, type WroteFrom } from "../src/agent/transcript/transcript";
import type { AuthorFeed } from "../src/workflow/feed/feed";
import { registeredConfig } from "../src/config/register-config";
import {
  storedWorkflowDefinition,
  type WorkflowDefinition,
} from "../src/config/workflow-definition";
import { TEST_DEFINITION_NAME } from "./test-config";
import type { Env } from "../src/env";
import { destinationFor } from "../src/notify/destination";
import { Notifier, type PostOptions } from "../src/notify/notifier";
import { recipientsOf, type Recipients } from "../src/notify/recipients";
import type { SandboxProvider } from "../src/sandbox/provider";
import { FakeSandboxProvider } from "./fake-sandbox";
import type { ConnectionState } from "../src/workflow/task/harness/bridge";
import { TurnCoalescer } from "../src/workflow/task/harness/turn";
import type { WorkflowDb } from "../src/workflow/store/db";
import { postToRecipients, releaseChatThreads, showWorking } from "../src/workflow/posts";
import {
  UNPLANNED_JOB_SLOTS,
  type StagePlan,
  type WorkflowPlan,
} from "../src/workflow/store/state";
import { artifactRefKey, jobInputKey } from "../src/workflow/store/input-key";
import {
  WorkflowStore,
  type JobRow,
  type NewJob,
  type SandboxRow,
  type TaskRow,
} from "../src/workflow/store/tasks";
import type { ScheduledMethod, Wake, WorkflowRuntime } from "../src/workflow/types";

export type FakeNote = { text: string; wake: Wake; from?: WroteFrom };

/** One armed alarm. A repeating alarm stays armed after it fires, until code stops it. */
export type FakeAlarm = {
  id: string;
  delay: number;
  method: ScheduledMethod;
  payload: unknown;
  repeats: boolean;
};

type FakeClose = { code: number; reason: string };

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

/** The id of the workflow a fake runtime creates. */
export const FAKE_WORKFLOW_ID = "wf_x";

/**
 * What a fake runtime's store holds when it opens. `running` is the workflow `wf_x`, started on
 * the test workflow definition, unless the store already holds a workflow.
 */
export type FakeOpening = "running" | "uncreated";

export class FakeRuntime implements WorkflowRuntime {
  env: Env;
  readonly store: WorkflowStore;
  notifier: Notifier;
  readonly transcript: TranscriptStore;
  readonly sessionFeeds = new Map<string, AuthorFeed>();
  readonly pageWritesOut = new Set<string>();
  sandboxProvider: FakeSandboxProvider = new FakeSandboxProvider();
  alarms: FakeAlarm[] = [];
  cancelled: string[] = [];
  sockets: Connection[] = [];
  posted: TaskEvent[] = [];
  /** Every channel post with the reply targets it went to, in order. */
  deliveries: Array<{ event: TaskEvent; targets: ReplyTarget[] }> = [];
  released: Array<ReplyTarget | null> = [];
  readonly agentTurns = new TurnCoalescer();
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
  modelInstance: LanguageModelV4 | null = null;
  modelsByName: Record<string, LanguageModelV4> = {};
  modelRequests: (string | undefined)[] = [];
  modelParams: Record<string, JSONValue>[] = [];
  modelGateways: (GatewayProvider | undefined)[] = [];
  clock: number | null = null;
  turnRunning = false;
  configOverride: Config | null = null;
  workflowDefinitionsOverride: WorkflowDefinition[] | null = null;
  private alarmSeq = 0;
  private notifiedChat: FakeChat | null = null;

  constructor(
    private readonly db: WorkflowDb,
    env: Env,
    opening: FakeOpening = "running",
  ) {
    this.env = env;
    this.store = new WorkflowStore(db);
    this.transcript = new TranscriptStore(db);
    this.notifier = new Notifier(
      { tracker: async () => null, chat: null, documents: async () => null },
      (entry) => this.store.writeOutbox(entry),
    );
    if (opening === "running" && !this.store.workflowRow()) {
      createFakeWorkflow(this);
      this.store.updateWorkflow({ status: "running" });
      this.store.writePlan({ definition: TEST_DEFINITION_NAME, name: "", reason: "", repo: null });
    }
  }

  /**
   * The same Durable Object after a restart. The store, the alarms, and the fakes stay. The
   * session feeds, the page writes out, the turn lane, and every turn the old instance held in
   * memory are gone.
   */
  restarted(): FakeRuntime {
    const next = new FakeRuntime(this.db, this.env, "uncreated");
    const { sessionFeeds, pageWritesOut, agentTurns } = next;
    Object.assign(next, this, { sessionFeeds, pageWritesOut, agentTurns, turnRunning: false });
    return next;
  }

  config(): Config {
    return this.configOverride ?? registeredConfig().config;
  }

  patchConfig(patch: Partial<Config>): Config {
    this.configOverride = { ...this.config(), ...patch };
    return this.configOverride;
  }

  workflowDefinitions(): readonly WorkflowDefinition[] {
    return this.workflowDefinitionsOverride ?? registeredConfig().workflowDefinitions;
  }

  workflowDefinition(): WorkflowDefinition {
    return storedWorkflowDefinition(
      this.workflowDefinitions(),
      this.store.plan()?.definition ?? null,
    );
  }

  /** The workflow definition a test patches: the one the plan named, else the test workflow definition. */
  patchableWorkflowDefinition(): WorkflowDefinition {
    const name = this.store.plan()?.definition ?? TEST_DEFINITION_NAME;
    return storedWorkflowDefinition(this.workflowDefinitions(), name);
  }

  /** Change the workflow definition the workflow runs, and keep the others. */
  patchWorkflowDefinition(patch: Partial<WorkflowDefinition>): void {
    const current = this.patchableWorkflowDefinition();
    const patched = { ...current, ...patch };
    this.workflowDefinitionsOverride = this.workflowDefinitions().map((definition) =>
      definition.name === current.name ? patched : definition,
    );
  }

  /** Add a workflow definition to the deployment, after the ones it holds. */
  addWorkflowDefinition(definition: WorkflowDefinition): void {
    this.workflowDefinitionsOverride = [...this.workflowDefinitions(), definition];
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

  async scheduleAlarmOnce(method: ScheduledMethod, payload: unknown): Promise<void> {
    const wanted = JSON.stringify(payload);
    const armed = this.alarms.some(
      (alarm) =>
        !alarm.repeats && alarm.method === method && JSON.stringify(alarm.payload) === wanted,
    );
    if (!armed) this.armAlarm({ delay: 0, method, payload, repeats: false });
  }

  async cancelAlarm(id: string): Promise<void> {
    this.cancelled.push(id);
    this.alarms = this.alarms.filter((alarm) => alarm.id !== id);
  }

  async cancelAlarmsWhere(
    method: ScheduledMethod,
    matches: (payload: unknown) => boolean,
  ): Promise<void> {
    for (const alarm of this.alarmsFor(method)) {
      if (matches(alarm.payload)) await this.cancelAlarm(alarm.id);
    }
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

  async post(
    event: TaskEvent,
    to: Recipients = { answering: [] },
    options: PostOptions = {},
  ): Promise<void> {
    this.posted.push(event);
    if (destinationFor(event) === "channel") {
      const audience = {
        origin: this.store.requireWorkflowRow().origin,
        replyTargets: this.store.replyTargets(),
      };
      this.deliveries.push({ event, targets: recipientsOf(audience, event, to) });
    }
    await postToRecipients(this, event, to, options);
  }

  async release(only?: ReplyTarget): Promise<void> {
    this.released.push(only ?? null);
    await releaseChatThreads(this, only);
  }

  working(text: string): Promise<void> {
    return showWorking(this, text);
  }

  /** Post, release, and show working through a recording chat, and return that chat. */
  postThroughChat(chat: FakeChat = new FakeChat()): FakeChat {
    this.notifiedChat = chat;
    this.notifier = new Notifier(
      { tracker: async () => null, chat, documents: async () => null },
      (entry) => this.store.writeOutbox(entry),
    );
    return chat;
  }

  /** The status the last status call set on a chat thread of `postThroughChat`. Null before any. */
  get chatSession(): SessionStatus | null {
    const last = this.notifiedChat?.argsOf("setSessionStatus").at(-1);
    return last ? (last[2] as SessionStatus) : null;
  }

  gateway(provider: GatewayProvider): Gateway | null {
    this.gatewayRequests.push(provider);
    return this.gatewayInstance;
  }

  decisions(): Decisions | null {
    const config = this.config();
    const orchestratorsGateway = this.gateway(orchestratorGateway(config));
    return orchestratorsGateway?.decisions(config.orchestrator.decisions_model) ?? null;
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

  async mcpCredential(_capability: McpCapability): Promise<string | null> {
    return this.mcpCredentialValue;
  }

  artifact(kind: ArtifactKind): Artifact {
    return artifact(kind, {
      adapters: this.config().adapters,
      code: () => this.code(),
      documents: () => this.documents(),
      tracker: () => this.tracker(),
      repo: () => this.store.plan()?.repo ?? null,
      log: (line) => this.log(null, line),
    });
  }

  sandbox(): SandboxProvider {
    return this.sandboxProvider;
  }

  agentTurnRunning(): boolean {
    return this.turnRunning;
  }

  async tellAgent(text: string, wake: Wake, from?: WroteFrom): Promise<void> {
    this.notes.push(from ? { text, wake, from } : { text, wake });
  }

  async agentTurn(): Promise<void> {
    const { runAgentTurn } = await import("../src/agent/turn/turn");
    await runAgentTurn(this);
  }

  async model(
    modelName?: string,
    params?: Record<string, JSONValue>,
    gateway?: GatewayProvider,
  ): Promise<LanguageModelV4> {
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

/** Create the workflow `wf_x` as `new`: before its plan, without an origin or a subject. */
export function createFakeWorkflow(workflow: FakeRuntime): void {
  workflow.store.createWorkflow({
    workflow_id: FAKE_WORKFLOW_ID,
    request_title: "",
    request_text: "",
    request_links: [],
    origin: null,
    subject: null,
  });
}

/** Merge a patch into the plan. A workflow without one gets the test workflow definition. */
export function patchPlan(workflow: WorkflowRuntime, patch: Partial<WorkflowPlan>): void {
  const current = workflow.store.plan() ?? {
    definition: TEST_DEFINITION_NAME,
    name: "",
    reason: "",
    repo: null,
  };
  workflow.store.writePlan({ ...current, ...patch });
}

/**
 * Merge a patch into the stage plan. A workflow without one gets the stages of its workflow
 * definition, the unplanned job slots, and no pages.
 */
export function patchStagePlan(workflow: FakeRuntime, patch: Partial<StagePlan>): void {
  const current = workflow.store.stagePlan() ?? {
    stages: workflow.patchableWorkflowDefinition().stages.map((stage) => stage.name),
    job_slots: UNPLANNED_JOB_SLOTS,
    page_parent: null,
    root_page: null,
  };
  workflow.store.writeStagePlan({ ...current, ...patch });
}

/** A task row patch, with the fields of the job the seeded task belongs to. */
export type SeedTaskPatch = Partial<TaskRow> & Partial<NewJob>;

/** The request a seeded job works from when the patch names no other input. */
const SEEDED_REQUEST = "Seeded request.";

/** The input kind and key of a seeded job, from the input columns the patch sets. */
export function seededJobInput(job: Partial<NewJob>): Pick<NewJob, "input_kind" | "input_key"> {
  if (job.issue_id) return { input_kind: "issue", input_key: job.input_key ?? job.issue_id };
  if (job.preceding_job_id) {
    const jobId = job.preceding_job_id;
    return { input_kind: "artifact", input_key: jobInputKey({ kind: "artifact", jobId }) };
  }
  if (job.input_ref && job.input_url) {
    const target = { ref: job.input_ref, url: job.input_url };
    return { input_kind: "target", input_key: job.input_key ?? artifactRefKey(target) };
  }
  return {
    input_kind: "request",
    input_key: job.input_key ?? jobInputKey({ kind: "request", text: SEEDED_REQUEST }),
  };
}

/** The job id a seeded task belongs to unless the patch names one: `wf_x.3` belongs to `wf_x-3`. */
function seedJobId(taskId: string): string {
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
      ...seededJobInput({ issue_id, input_key, preceding_job_id, input_ref, input_url }),
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
  return workflow.store.requireTask(taskId);
}

export type SeedArtifact = { status?: ArtifactStatus; refiner_task_id?: string; number?: number };

export function seedPullRequestTask(
  workflow: FakeRuntime,
  patch: SeedTaskPatch = {},
  seed: SeedArtifact = {},
): TaskRow {
  patchPlan(workflow, { repo: "acme/app" });
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
    ref: { kind: "issue", issue_id: "issue-42", issue_key: "ENG-42" },
  });
  if (seed.status && seed.status !== "drafted") {
    workflow.store.advanceArtifact(task.job_id, ["drafted"], seed.status);
  }
  if (seed.refiner_task_id) {
    workflow.store.setArtifactRefinerRun(task.job_id, seed.refiner_task_id);
  }
  return workflow.store.requireTask(task.task_id);
}

const REVIEW_AUTHOR = "wf_x.1";
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
    stages: workflow.patchableWorkflowDefinition().stages.map((stage) => ({ ...stage, reviewers })),
  });
}

/** Replace the polisher list of every stage, so a test can run refiners that change the artifact. */
export function patchStagePolishers(workflow: FakeRuntime, polishers: RefinerEntry[]): void {
  workflow.patchWorkflowDefinition({
    stages: workflow.patchableWorkflowDefinition().stages.map((stage) => ({ ...stage, polishers })),
  });
}

/** Give every stage a research step on the mock harness, so a researcher runs before each author. */
export function patchStageResearch(workflow: FakeRuntime): void {
  const research = { skill: "research", harness: "opencode" as const, model: "mock" };
  workflow.patchWorkflowDefinition({
    stages: workflow.patchableWorkflowDefinition().stages.map((stage) => ({ ...stage, research })),
  });
}

/** The gateway model id a model-call author produces on in tests. */
export const MODEL_AUTHOR_MODEL = "openrouter/x-ai/grok-4.6";

/** The page parent a test plan names. */
export const PAGE_PARENT = "project-1";

/** Run the author of every stage as a model-call task on a fake document host, under the test page parent. */
export function patchModelExecution(workflow: FakeRuntime): FakeDocuments {
  patchStagePlan(workflow, { page_parent: PAGE_PARENT });
  return patchModelAuthors(workflow);
}

/** Run the author of every stage as a model-call task on a fake document host, before any plan. */
export function patchModelAuthors(workflow: FakeRuntime): FakeDocuments {
  workflow.patchWorkflowDefinition({
    stages: workflow.patchableWorkflowDefinition().stages.map((stage) => ({
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
  patchModelAuthors(workflow);
  const definition = workflow.patchableWorkflowDefinition();
  workflow.patchWorkflowDefinition({ documents: { ...definition.documents, root_page: "design" } });
  const host = new FakeDocuments({ ...answers, nests: true });
  workflow.documentsInstance = host;
  return host;
}

/** Holds each page create and update of a fake host until `release`, and counts the most out at once. */
export class GatedPageWrites {
  private openGate: () => void = () => {};
  private markWaiting: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });
  private out = 0;
  /** The most page writes that were out at once. */
  mostOut = 0;
  /** Resolves once a page write waits at the gate. */
  readonly waiting = new Promise<void>((resolve) => {
    this.markWaiting = resolve;
  });

  constructor(documents: FakeDocuments) {
    const createPage = documents.createPage.bind(documents);
    const updatePageContent = documents.updatePageContent.bind(documents);
    documents.createPage = (title, text, parent) =>
      this.held(() => createPage(title, text, parent));
    documents.updatePageContent = (pageId, change) =>
      this.held(() => updatePageContent(pageId, change));
  }

  /** Let every waiting and later page write go to the host. */
  release(): void {
    this.openGate();
  }

  private async held<Result>(write: () => Promise<Result>): Promise<Result> {
    this.out += 1;
    this.mostOut = Math.max(this.mostOut, this.out);
    this.markWaiting();
    await this.gate;
    try {
      return await write();
    } finally {
      this.out -= 1;
    }
  }
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
    preceding_job_id: null,
    branch: null,
    brief: "",
    ...job,
    ...seededJobInput(job),
  });
  workflow.store.insertTask({
    task_id: "wf_x.1",
    job_id: job.job_id ?? "wf_x-1",
    role: "author",
    model: MODEL_AUTHOR_MODEL,
    sandbox: null,
  });
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
