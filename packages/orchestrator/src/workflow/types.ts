import type { Chat } from "@artfct-ai/adapters/chat/types";
import type { CodeHost } from "@artfct-ai/adapters/code/types";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import type { Decisions, Gateway } from "@artfct-ai/adapters/gateway/types";
import type { Harness, HarnessAdapter } from "@artfct-ai/adapters/harness/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { Web } from "@artfct-ai/adapters/web/types";
import type { Config } from "../config/config";
import type { WorkflowDefinition } from "../config/workflow-definition";
import type { GatewayProvider } from "../config/gateway";
import type { McpCapability } from "../config/adapters";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type {
  ArtifactKind,
  RpcAck,
  WorkflowStatus,
  WorkflowSummary,
} from "@artfct-ai/contracts/types";
import type { Artifact } from "../artifact/types";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ResolvedStage } from "../config/stage";
import type { TaskEvent } from "./task/events";
import type { Connection } from "agents";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { JSONValue, ToolSet } from "ai";
import type { TranscriptStore, WroteFrom } from "../agent/transcript/transcript";
import type { AuthorFeed } from "./feed/feed";
import type { Env } from "../env";
import type { Notifier, PostOptions } from "../notify/notifier";
import type { Recipients } from "../notify/recipients";
import type { SandboxProvider } from "../sandbox/provider";
import type { JobRow, TaskRow, WorkflowStore } from "./store/tasks";
import type { TurnCoalescer } from "./task/harness/turn";

/** Methods on the Workflow DO that alarms may call by name. */
export type ScheduledMethod =
  | "runAgent"
  | "onTurnTimeout"
  | "onTurnHeadsUp"
  | "provision"
  | "onNoProgress"
  | "onWallClock"
  | "onHelloTimeout"
  | "refreshToken"
  | "keepSandboxAlive"
  | "retryQueue"
  | "settleIdleAuthor"
  | "settleLostJudgeRuling"
  | "onBridgeLost"
  | "flushBoard"
  | "onIdle"
  | "recheckChecks"
  | "tendSessionFeed"
  | "onModelTurnDeadline"
  | "resumeLostCalls"
  | "resumeWorkflowEnd"
  | "resumeTaskEnd"
  | "runLostModelTurnAgain"
  | "postClosingReply"
  | "postHandover"
  | "resumeRefinerTurnEnd";

/**
 * Why the orchestrator model is needed now. Every caller of `tellAgent` declares one.
 * `none` records the text for the next turn without starting one.
 */
export type Wake =
  | "none"
  | "task_result"
  | "task_idle"
  | "human"
  | "message"
  | "external_state"
  | "blocked";

/** What the deterministic layer did with an event, and why the agent is needed after it. */
export type Applied = { notes: string[]; wake: Wake };

/** What the workflow logic modules need from the Durable Object, and tests fake. */
export interface WorkflowRuntime {
  readonly env: Env;
  readonly store: WorkflowStore;
  readonly notifier: Notifier;
  readonly transcript: TranscriptStore;
  /** The in-memory session feed of each author's running turn, by task id. */
  readonly sessionFeeds: Map<string, AuthorFeed>;
  /** The model turns of this instance whose page write is out, by turn id. A stop leaves them in flight. */
  readonly pageWritesOut: Set<string>;
  config(): Config;
  /** The workflow definitions of the deployment. A plan names one of them. */
  workflowDefinitions(): readonly WorkflowDefinition[];
  /** The workflow definition this workflow runs, which its plan named. Throws before the plan. */
  workflowDefinition(): WorkflowDefinition;
  /** The settings of a job's stage. */ stageFor(job: JobRow): ResolvedStage;
  /** The settings of the stage a task's job runs. */ stageForTask(task: TaskRow): ResolvedStage;
  /** Schedule a method call by name. Returns the schedule id. */
  scheduleAlarm(delaySeconds: number, method: ScheduledMethod, payload: unknown): Promise<string>;
  /** Schedule a method call due now, unless the same method with the same payload is scheduled. */
  scheduleAlarmOnce(method: ScheduledMethod, payload: unknown): Promise<void>;
  cancelAlarm(id: string): Promise<void>;
  /** Cancel each scheduled call of a method whose payload matches. Returns their payloads. */
  cancelAlarmsWhere(
    method: ScheduledMethod,
    matches: (payload: unknown) => boolean,
  ): Promise<unknown[]>;
  /** Call a method by name at an interval. A method and payload that already repeat start nothing. */
  startRepeatingAlarm(
    everySeconds: number,
    method: ScheduledMethod,
    payload: unknown,
  ): Promise<void>;
  /** Stop the repeating call of a method with this payload. */
  stopRepeatingAlarm(method: ScheduledMethod, payload: unknown): Promise<void>;
  cancelAllAlarms(): Promise<void>;
  /** Tear the Durable Object down: alarms off, every table gone, and the isolate aborted. */
  destroy(): Promise<void>;
  /** Open bridge sockets. With a task id, only that task's socket. */
  connections(taskId?: string): Connection[];
  log(taskId: string | null, line: string): void;
  /**
   * Post to the recipients, by default the workflow's audience. `recipientsOf` picks the reply
   * targets. The runtime adds whether the workflow is finished.
   */
  post(event: TaskEvent, to?: Recipients, options?: PostOptions): Promise<void>;
  /** Nothing to say. Take every chat thread, or one, out of its working status. */
  release(only?: ReplyTarget): Promise<void>;
  /** Show every chat thread what the agent is doing now. A status line, never a message. */
  working(text: string): Promise<void>;
  /** The named gateway, or null while a secret it needs is unset. */
  gateway(provider: GatewayProvider): Gateway | null;
  /** The decisions models the config names, on the orchestrator's gateway. Null while a secret it needs is unset. */
  decisions(): Decisions | null;
  /** The adapter for a harness, holding the deployment secrets it may take. */
  harness(name: Harness): HarnessAdapter;
  code(): CodeHost | null;
  /** The chat channel the notifier posts through, for reading back in it. Null without a token. */
  chat(): Chat | null;
  tracker(): Promise<Tracker | null>;
  /** The configured document host. Null without its credential. */
  documents(): Promise<Documents | null>;
  /** Page reads over HTTP. */
  web(): Web;
  /** The credential the deployment holds for one capability's MCP server. Null without one. */
  mcpCredential(capability: McpCapability): Promise<string | null>;
  /** Everything that depends on the kind of artifact a stage produces. */
  artifact(kind: ArtifactKind): Artifact;
  sandbox(): SandboxProvider;
  /**
   * Queue text for the orchestrator agent. Any wake class but `none` schedules a turn now. `from`
   * says where the person who wrote it wrote from.
   */
  tellAgent(text: string, wake: Wake, from?: WroteFrom): Promise<void>;
  /** The turn lane: one agent turn at a time, and the wakes during a turn become one more turn. */
  readonly agentTurns: TurnCoalescer;
  /** Run one agent turn on the inbox. Only the turn lane calls it. */
  agentTurn(): Promise<void>;
  /** The orchestrator's model, or a named prompt's model with its request fields and gateway. */
  model(
    modelName?: string,
    params?: Record<string, JSONValue>,
    gateway?: GatewayProvider,
  ): Promise<LanguageModelV4>;
  /** Tools from the MCP servers the orchestrator is connected to. */
  mcpTools(): Promise<ToolSet>;
  /** The current time in ms. The one clock the logic modules read, so tests can set it. */
  now(): number;
}

/** Why a conversation did not take an event the router handed it: it is not opened yet, or its workflow ended. */
export type EventRefusal =
  | { refused: "not_created" }
  | { refused: "ended"; status: WorkflowStatus };

/** The RPC surface of the Workflow Durable Object. The orchestrator entrypoint calls it. */
export interface WorkflowRpc {
  /** Open the conversation from its first event and the ended workflow it follows. */
  create(
    conversationId: string,
    event: InboundEvent,
    endedWorkflowId: string | null,
  ): Promise<RpcAck>;
  /** Take a later event, or refuse it so the router routes it elsewhere. */
  handle(event: InboundEvent): Promise<RpcAck | EventRefusal>;
  /** The status summary of the workflow. Null before a plan creates one. */
  status(): Promise<WorkflowSummary | null>;
  debug(): Promise<unknown>;
}
