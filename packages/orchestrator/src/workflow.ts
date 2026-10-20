import type { Chat } from "@artfct-ai/adapters/chat/types";
import type { CodeHost } from "@artfct-ai/adapters/code/types";
import type { Decisions, Gateway } from "@artfct-ai/adapters/gateway/types";
import type { Harness, HarnessAdapter } from "@artfct-ai/adapters/harness/types";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { Web } from "@artfct-ai/adapters/web/types";
import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import { BridgeHeartbeat } from "@artfct-ai/acp/methods";
import type { ArtifactKind, RpcAck, WorkflowSummary } from "@artfct-ai/contracts/types";
import type { Artifact } from "./artifact/types";
import type { Config } from "./config/config";
import { orchestratorGateway, type GatewayAdapter, type GatewayProvider } from "./config/gateway";
import type {
  ChatProvider,
  CodeProvider,
  DocumentsProvider,
  McpCapability,
  Adapters,
} from "./config/adapters";
import { resolveStage, type ResolvedStage, type Stage } from "./config/stage";
import { storedWorkflowDefinition, type WorkflowDefinition } from "./config/workflow-definition";
import type { TaskEvent } from "./workflow/task/events";
import { tracing } from "cloudflare:workers";
import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { JSONValue, ToolSet } from "ai";
import { allowedMcpTools, connectOrchestratorMcp } from "./agent/tools/mcp";
import { TranscriptStore, type WroteFrom } from "./agent/transcript/transcript";
import { postClosingReply, type AuthorFeed, type ClosingReplyAlarm } from "./workflow/feed/feed";
import {
  onTurnHeadsUp,
  onTurnTimeout,
  resumeLostTurn,
  type TurnAlarm,
} from "./agent/turn/watchdog";
import { runAgent, tellAgent } from "./agent/turn/tell";
import {
  artifact,
  chat,
  codeHost,
  documents,
  gateway,
  harness,
  mcpCredential,
  tracker,
  web,
} from "./clients";
import { registeredConfig } from "./config/register-config";
import type { Env } from "./env";
import { Notifier, type PostOptions } from "./notify/notifier";
import type { Recipients } from "./notify/recipients";
import { CloudflareSandboxProvider } from "./sandbox/cloudflare";
import type { SandboxProvider } from "./sandbox/provider";
import {
  acceptBridge,
  authorizeBridge,
  connectionTask,
  onBridgeClosed,
  onBridgeLost,
  onBridgeMessage,
  type ConnectionState,
} from "./workflow/task/harness/bridge";
import { onFlushBoard, type BoardAlarm } from "./workflow/board/board";
import { postToRecipients, releaseChatThreads, showWorking } from "./workflow/posts";
import { openWorkflowDb } from "./workflow/store/db";
import { createWorkflow, eventRefusalOf, handleEvent } from "./workflow/inbound/events";
import {
  armWorkflowEndAlarm,
  onIdle,
  resumeTaskEnd,
  resumeWorkflowEnd,
  type TaskEndAlarm,
} from "./workflow/lifecycle";
import type { ChecksAlarm } from "./workflow/refiner/checks-gate";
import { recheckChecks } from "./workflow/refiner/checks-recheck";
import { settleLostJudgeRuling } from "./workflow/refiner/loop";
import { retryQueue } from "./workflow/task/harness/prompt-queue";
import { provision, provisionQueuedTasks } from "./workflow/task/sandbox/sandbox";
import {
  onModelTurnDeadline,
  runLostModelTurnAgain,
  type ModelTurnAlarm,
  type RunAgainAlarm,
} from "./workflow/task/model-turn";
import { armLostCallsAlarm, resumeLostCalls, type LostCallsAlarm } from "./workflow/restart";
import { settleIdleAuthor, settleIdleAuthors, TurnCoalescer } from "./workflow/task/harness/turn";
import type {
  EventRefusal,
  ScheduledMethod,
  Wake,
  WorkflowRpc,
  WorkflowRuntime,
} from "./workflow/types";
import { initialWorkflowState, type WorkflowState } from "./workflow/store/state";
import { debugDump, summarize } from "./workflow/status";
import { WorkflowStore, type JobRow, type TaskRow } from "./workflow/store/tasks";
import {
  keepSandboxAlive,
  onHelloTimeout,
  onNoProgress,
  onWallClock,
  type GenerationAlarm,
  type TaskAlarm,
} from "./workflow/task/harness/timers";
import { refreshToken } from "./workflow/task/sandbox/credential";

export type { WorkflowState } from "./workflow/store/state";

const MCP_WAIT_MS = 10_000;

/**
 * Factories for everything the workflow reaches outside its own storage. One copy per DO
 * instance, which a test replaces entries on before it drives the DO.
 */
export type WorkflowServices = {
  gateway: (
    env: Env,
    provider: GatewayProvider,
    region: GatewayAdapter["region"],
  ) => Gateway | null;
  harness: (env: Env, name: Harness) => HarnessAdapter;
  code: (env: Env, provider: CodeProvider) => CodeHost | null;
  tracker: (env: Env) => Promise<Tracker | null>;
  documents: (env: Env, provider: DocumentsProvider) => Promise<Documents | null>;
  web: () => Web;
  mcpCredential: (options: {
    env: Env;
    capability: McpCapability;
    adapters: Adapters;
  }) => Promise<string | null>;
  chat: (env: Env, provider: ChatProvider) => Chat | null;
  sandbox: (env: Env) => SandboxProvider;
  model: (
    workflow: WorkflowRuntime,
    modelName?: string,
    params?: Record<string, JSONValue>,
    gateway?: GatewayProvider,
  ) => Promise<LanguageModelV4>;
  now: () => number;
};

export const defaultServices: WorkflowServices = {
  gateway,
  harness,
  code: codeHost,
  tracker,
  documents: documents,
  web,
  mcpCredential,
  chat,
  sandbox: (env) => new CloudflareSandboxProvider(env),
  model: async (workflow, modelName, params, provider) => {
    const { orchestratorModel } = await import("./agent/model/model");
    return orchestratorModel(workflow, modelName, { params, gateway: provider });
  },
  now: Date.now,
};

/**
 * One workflow, one Durable Object. The logic lives in `./agent/*` and `./workflow/*`. This
 * class is the runtime those modules run against, plus the RPC and alarm entry points.
 */
export class Workflow extends Agent<Env, WorkflowState> implements WorkflowRuntime, WorkflowRpc {
  initialState: WorkflowState = initialWorkflowState;
  /** Widen the Agent's protected env so the logic modules can read bindings. */
  declare public env: Env;
  store!: WorkflowStore;
  notifier!: Notifier;
  transcript!: TranscriptStore;
  readonly sessionFeeds = new Map<string, AuthorFeed>();
  readonly pageWritesOut = new Set<string>();
  /** The chat the notifier posts through, kept so the agent can read back through it. */
  private chatClient: Chat | null = null;
  readonly agentTurns = new TurnCoalescer();
  /** Built once so the token caches live as long as the DO. */
  private codeMemo: CodeHost | null | undefined;
  private trackerMemo: Promise<Tracker | null> | undefined;
  private documentsMemo: Promise<Documents | null> | undefined;
  /** The credential the connected MCP server holds, so a rotated one is connected again. */
  connectedMcpCredential: string | null = null;
  /** The outside world. Tests swap entries for fakes. */
  services: WorkflowServices = { ...defaultServices };

  /** Answer the bridge heartbeat from the runtime, so an idle socket stays open without waking the DO. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(BridgeHeartbeat.request, BridgeHeartbeat.response),
    );
  }

  /** Migrate storage, build the stores and the notifier, then pick up any turn this DO lost. */
  async onStart(): Promise<void> {
    const db = await openWorkflowDb(this.ctx.storage);
    this.store = new WorkflowStore(db);
    this.transcript = new TranscriptStore(db);
    this.chatClient = this.services.chat(this.env, this.config().adapters.chat.provider);
    this.notifier = new Notifier(
      { tracker: () => this.tracker(), chat: this.chatClient, documents: () => this.documents() },
      (entry) => this.store.writeOutbox(entry),
    );
    await armLostCallsAlarm(this);
    await armWorkflowEndAlarm(this);
    await resumeLostTurn(this);
    await provisionQueuedTasks(this);
    await settleIdleAuthors(this);
  }

  async create(
    workflowId: string,
    event: InboundEvent,
    endedWorkflowId: string | null,
  ): Promise<RpcAck> {
    await this.lifecycle.start();
    return createWorkflow(this, { workflowId, event, endedWorkflowId });
  }

  async handle(event: InboundEvent): Promise<RpcAck | EventRefusal> {
    await this.lifecycle.start();
    const refusal = eventRefusalOf(this, event);
    if (refusal) return refusal;
    return this.inSpan(`event ${event.kind}`, null, () => handleEvent(this, event));
  }

  async status(): Promise<WorkflowSummary> {
    await this.lifecycle.start();
    return summarize(this);
  }

  async debug(): Promise<unknown> {
    await this.lifecycle.start();
    return debugDump(this);
  }

  /** The `runAgent` alarm: the backup alarm behind `tellAgent`, and the wake a restart arms. */
  runAgent(): Promise<void> {
    return runAgent(this);
  }

  /** Resolves when no agent turn is running. For the tests and the smoke run. */
  settle(): Promise<void> {
    return this.agentTurns.idle();
  }

  onTurnTimeout(alarm: TurnAlarm): Promise<void> {
    return this.inSpan("alarm onTurnTimeout", null, () => onTurnTimeout(this, alarm));
  }

  /** Alarm: post the heads-up of a turn on a person's message. */
  onTurnHeadsUp(alarm: TurnAlarm): Promise<void> {
    return this.inSpan("alarm onTurnHeadsUp", null, () => onTurnHeadsUp(this, alarm));
  }

  provision(alarm: TaskAlarm): Promise<void> {
    return this.inSpan("alarm provision", alarm.task_id, () => provision(this, alarm.task_id));
  }

  onNoProgress(alarm: GenerationAlarm): Promise<void> {
    return this.inSpan("alarm onNoProgress", alarm.task_id, () => onNoProgress(this, alarm));
  }

  onWallClock(alarm: TaskAlarm): Promise<void> {
    return this.inSpan("alarm onWallClock", alarm.task_id, () => onWallClock(this, alarm));
  }

  onHelloTimeout(alarm: GenerationAlarm): Promise<void> {
    return this.inSpan("alarm onHelloTimeout", alarm.task_id, () => onHelloTimeout(this, alarm));
  }

  refreshToken(alarm: TaskAlarm): Promise<void> {
    return this.inSpan("alarm refreshToken", alarm.task_id, () => refreshToken(this, alarm));
  }

  keepSandboxAlive(alarm: GenerationAlarm): Promise<void> {
    return this.inSpan("alarm keepSandboxAlive", alarm.task_id, () =>
      keepSandboxAlive(this, alarm),
    );
  }

  retryQueue(alarm: GenerationAlarm): Promise<void> {
    return this.inSpan("alarm retryQueue", alarm.task_id, () => retryQueue(this, alarm));
  }

  settleIdleAuthor(alarm: GenerationAlarm): Promise<void> {
    return this.inSpan("alarm settleIdleAuthor", alarm.task_id, () =>
      settleIdleAuthor(this, alarm),
    );
  }

  /** Alarm: post a closing reply whose post an instance restart cut. */
  postClosingReply(alarm: ClosingReplyAlarm): Promise<void> {
    return this.inSpan("alarm postClosingReply", alarm.activity.task_id, () =>
      postClosingReply(this, alarm),
    );
  }

  settleLostJudgeRuling(alarm: TaskAlarm): Promise<void> {
    return this.inSpan("alarm settleLostJudgeRuling", alarm.task_id, () =>
      settleLostJudgeRuling(this, alarm),
    );
  }

  onBridgeLost(alarm: GenerationAlarm): Promise<void> {
    return this.inSpan("alarm onBridgeLost", alarm.task_id, () => onBridgeLost(this, alarm));
  }

  flushBoard(alarm: BoardAlarm): Promise<void> {
    return this.inSpan("alarm flushBoard", null, () => onFlushBoard(this, alarm));
  }

  onIdle(): Promise<void> {
    return onIdle(this);
  }

  recheckChecks(alarm: ChecksAlarm): Promise<void> {
    return this.inSpan("alarm recheckChecks", null, () => recheckChecks(this, alarm));
  }

  resumeWorkflowEnd(): Promise<void> {
    return this.inSpan("alarm resumeWorkflowEnd", null, () => resumeWorkflowEnd(this));
  }

  resumeTaskEnd(alarm: TaskEndAlarm): Promise<void> {
    return this.inSpan("alarm resumeTaskEnd", alarm.task_id, () => resumeTaskEnd(this, alarm));
  }

  resumeLostCalls(alarm: LostCallsAlarm): Promise<void> {
    return this.inSpan("alarm resumeLostCalls", null, () => resumeLostCalls(this, alarm));
  }

  runLostModelTurnAgain(alarm: RunAgainAlarm): Promise<void> {
    return this.inSpan("alarm runLostModelTurnAgain", alarm.task_id, () =>
      runLostModelTurnAgain(this, alarm),
    );
  }

  onModelTurnDeadline(alarm: ModelTurnAlarm): Promise<void> {
    return this.inSpan("alarm onModelTurnDeadline", alarm.task_id, () =>
      onModelTurnDeadline(this, alarm),
    );
  }

  /** Bridge sockets carry ACP only. State sync frames would leak the request and reply targets. */
  shouldSendProtocolMessages(): boolean {
    return false;
  }

  /** Only the workflow writes its state. A state frame from a bridge socket is refused. */
  validateStateChange(_nextState: WorkflowState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("a bridge socket cannot write the workflow state");
  }

  /** The bridge dials in here with the token of its sandbox. */
  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const sandbox = authorizeBridge(this.store, context.request);
    if (!sandbox) {
      connection.close(4001, "unauthorized");
      return;
    }
    acceptBridge(this, connection, sandbox);
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message === "string") await onBridgeMessage(this, connection, message);
  }

  async onClose(connection: Connection): Promise<void> {
    const state = connection.state as ConnectionState | null;
    if (!state) return;
    await onBridgeClosed(this, state);
  }

  /** One agent turn in a span, with the turn code loaded at its first use. */
  agentTurn(): Promise<void> {
    return this.inSpan("agent turn", null, () =>
      import("./agent/turn/turn").then((turn) => turn.runAgentTurn(this)),
    );
  }

  /** Run one entry point in a span that names the workflow and the task, so a trace is found by either. */
  private inSpan<Result>(name: string, taskId: string | null, run: () => Result): Result {
    return tracing.enterSpan(name, (span) => {
      span.setAttribute("workflow.id", this.state.workflow_id);
      if (taskId) span.setAttribute("task.id", taskId);
      return run();
    });
  }

  patchState(patch: Partial<WorkflowState>): void {
    this.setState({ ...this.state, ...patch });
  }

  config(): Config {
    return registeredConfig().config;
  }

  workflowDefinitions(): readonly WorkflowDefinition[] {
    return registeredConfig().workflowDefinitions;
  }

  workflowDefinition(): WorkflowDefinition {
    return storedWorkflowDefinition(this.workflowDefinitions(), this.state.definition);
  }

  stageFor(job: JobRow): ResolvedStage {
    return resolveStage(this.config(), this.stageDefinition(job));
  }

  stageForTask(task: TaskRow): ResolvedStage {
    return this.stageFor(this.store.requireJob(task.job_id));
  }

  /** The stage a job runs. Throws when the workflow definition no longer declares it. */
  private stageDefinition(job: JobRow): Stage {
    const stage = this.workflowDefinition().stages.find((declared) => declared.name === job.stage);
    if (!stage)
      throw new Error(`Stage ${job.stage} of job ${job.job_id} is not in the workflow definition.`);
    return stage;
  }

  async scheduleAlarm(
    delaySeconds: number,
    method: ScheduledMethod,
    payload: unknown,
  ): Promise<string> {
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
      throw new Error(
        `alarm ${method}: delay must be a finite number of seconds, got ${delaySeconds}`,
      );
    }
    const scheduled = await this.schedule(delaySeconds, method, payload);
    return scheduled.id;
  }

  async scheduleAlarmOnce(method: ScheduledMethod, payload: unknown): Promise<void> {
    await this.schedule(0, method, payload, { idempotent: true });
  }

  async cancelAlarm(id: string): Promise<void> {
    await this.cancelSchedule(id);
  }

  async startRepeatingAlarm(
    everySeconds: number,
    method: ScheduledMethod,
    payload: unknown,
  ): Promise<void> {
    await this.scheduleEvery(everySeconds, method, payload);
  }

  async stopRepeatingAlarm(method: ScheduledMethod, payload: unknown): Promise<void> {
    const wanted = JSON.stringify(payload);
    for (const scheduled of this.getSchedules({ type: "interval" })) {
      if (scheduled.callback !== method || JSON.stringify(scheduled.payload) !== wanted) continue;
      await this.cancelSchedule(scheduled.id);
    }
  }

  async cancelAllAlarms(): Promise<void> {
    for (const scheduled of this.getSchedules()) await this.cancelSchedule(scheduled.id);
  }

  connections(taskId?: string): Connection[] {
    const all = [...this.getConnections()];
    if (!taskId) return all;
    return all.filter((connection) => connectionTask(connection) === taskId);
  }

  log(taskId: string | null, line: string): void {
    this.store.appendLog(taskId, line);
    const workflowId = this.state.workflow_id;
    console.log({
      message: `[${workflowId}${taskId ? `/${taskId}` : ""}] ${line}`,
      workflow_id: workflowId,
      task_id: taskId,
    });
  }

  post(event: TaskEvent, to?: Recipients, options?: PostOptions): Promise<void> {
    return postToRecipients(this, event, to, options);
  }

  release(only?: ReplyTarget): Promise<void> {
    return releaseChatThreads(this, only);
  }

  gateway(provider: GatewayProvider): Gateway | null {
    return this.services.gateway(this.env, provider, this.config().adapters.gateway.region);
  }

  decisions(): Decisions | null {
    const config = this.config();
    const orchestratorsGateway = this.gateway(orchestratorGateway(config));
    return orchestratorsGateway?.decisions(config.orchestrator.decisions_model) ?? null;
  }

  harness(name: Harness): HarnessAdapter {
    return this.services.harness(this.env, name);
  }

  code(): CodeHost | null {
    if (this.codeMemo === undefined) {
      this.codeMemo = this.services.code(this.env, this.config().adapters.code.provider);
    }
    return this.codeMemo;
  }

  chat(): Chat | null {
    return this.chatClient;
  }

  tracker(): Promise<Tracker | null> {
    this.trackerMemo ??= keepClientOnly(this.services.tracker(this.env), () => {
      this.trackerMemo = undefined;
    });
    return this.trackerMemo;
  }

  documents(): Promise<Documents | null> {
    this.documentsMemo ??= keepClientOnly(
      this.services.documents(this.env, this.config().adapters.documents.provider),
      () => {
        this.documentsMemo = undefined;
      },
    );
    return this.documentsMemo;
  }

  web(): Web {
    return this.services.web();
  }

  mcpCredential(capability: McpCapability): Promise<string | null> {
    return this.services.mcpCredential({
      env: this.env,
      capability,
      adapters: this.config().adapters,
    });
  }

  artifact(kind: ArtifactKind): Artifact {
    return artifact(kind, {
      adapters: this.config().adapters,
      code: () => this.code(),
      documents: () => this.documents(),
      tracker: () => this.tracker(),
      repo: () => this.state.repo?.full ?? null,
      log: (line) => this.log(null, line),
    });
  }

  sandbox(): SandboxProvider {
    return this.services.sandbox(this.env);
  }

  tellAgent(text: string, wake: Wake, from?: WroteFrom): Promise<void> {
    return tellAgent(this, text, wake, from);
  }

  working(text: string): Promise<void> {
    return showWorking(this, text);
  }

  model(
    modelName?: string,
    params?: Record<string, JSONValue>,
    provider?: GatewayProvider,
  ): Promise<LanguageModelV4> {
    return this.services.model(this, modelName, params, provider);
  }

  now(): number {
    return this.services.now();
  }

  async mcpTools(): Promise<ToolSet> {
    const connected = await connectOrchestratorMcp(this);
    await this.mcp.waitForConnections({ timeout: MCP_WAIT_MS });
    return allowedMcpTools(connected, this.mcp.getAITools());
  }
}

/**
 * A client lookup that forgets itself when it finds no client or fails, so a credential
 * installed later is found on the next call.
 */
function keepClientOnly<Client>(
  lookup: Promise<Client | null>,
  forget: () => void,
): Promise<Client | null> {
  return lookup.then(
    (client) => {
      if (!client) forget();
      return client;
    },
    (error: unknown) => {
      forget();
      throw error;
    },
  );
}
