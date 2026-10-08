import type {
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  METHOD_NOT_FOUND,
  errorOf,
  jsonRpcErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  jsonRpcNotification,
  parseMessage,
  jsonRpcRequest,
  jsonRpcResponse,
  resultOf,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
} from "@artfct-ai/acp/jsonrpc";
import {
  BridgeMethods,
  ClientMethods,
  type BridgeExitParams,
  type BridgeHelloParams,
  type BridgeLogParams,
} from "@artfct-ai/acp/methods";
import { bridgeTokenOf } from "@artfct-ai/acp/bridge-token";
import { chooseAllowOption } from "@artfct-ai/acp/updates";
import type { Connection } from "agents";
import { parseBridgePath } from "./bridge-path";
import { onBridgeExit, onBridgeHello, onEffortSet, onInitialized, onSessionNew } from "./session";
import { LOGGED_ERROR_CHARS, onRpcError, onSessionUpdate, onTurnEnd } from "./turn";
import { drainQueue, RECONNECT_CEILING_MS } from "./prompt-queue";
import type { GenerationAlarm } from "./timers";
import type { WorkflowRuntime } from "../../types";
import { isTaskFinished } from "../../store/state";
import { sandboxRefOf } from "../sandbox/size";
import type { RpcPurpose } from "../../store/schema";
import type { SandboxRow, TaskRow, WorkflowStore } from "../../store/tasks";

/** What the Workflow DO attaches to each bridge socket. */
export type ConnectionState = { task_id: string; generation: number };

/** The task a bridge socket belongs to, from the state set when it connected. */
export function connectionTask(connection: Connection): string | null {
  return (connection.state as ConnectionState | null)?.task_id ?? null;
}

/** The task a bridge socket serves. Null for a socket of an older generation, or of no task. */
function servedTask(workflow: WorkflowRuntime, state: ConnectionState | null): TaskRow | null {
  const sandbox = state ? workflow.store.sandbox(state.task_id) : null;
  if (!sandbox || sandbox.generation !== state?.generation) return null;
  return workflow.store.task(sandbox.task_id);
}

/** The sandbox a bridge dial names. Null unless the dial carries that sandbox's token. */
export function authorizeBridge(store: WorkflowStore, dial: Request): SandboxRow | null {
  const bridge = parseBridgePath(new URL(dial.url).pathname);
  const sandbox = bridge ? store.sandbox(bridge.taskId) : null;
  if (!sandbox || sandbox.bridge_token !== bridgeTokenOf(dial.headers)) return null;
  return sandbox;
}

/** Register an authorized bridge socket for its task. An older socket of the task is closed. */
export function acceptBridge(
  workflow: WorkflowRuntime,
  connection: Connection,
  sandbox: SandboxRow,
): void {
  for (const other of workflow.connections(sandbox.task_id)) {
    if (other.id !== connection.id) other.close(4002, "replaced");
  }
  const state: ConnectionState = { task_id: sandbox.task_id, generation: sandbox.generation };
  connection.setState(state);
  workflow.log(sandbox.task_id, "bridge connected");
}

/** Send a JSON-RPC request to the bridge. The id and purpose are stored until it answers. */
export function sendRequest(
  workflow: WorkflowRuntime,
  task: TaskRow,
  method: string,
  params: unknown,
  purpose: RpcPurpose,
): number {
  const id = workflow.store.insertRpc(task.task_id, method, purpose);
  send(workflow, task, jsonRpcRequest(id, method, params));
  return id;
}

/** Send a JSON-RPC notification to the bridge. Nothing answers it. */
export function sendNotification(
  workflow: WorkflowRuntime,
  task: TaskRow,
  method: string,
  params: unknown,
): void {
  send(workflow, task, jsonRpcNotification(method, params));
}

/** True while the socket still carries frames. A closed or closing one drops what it is sent. */
function isOpen(connection: Connection): boolean {
  return connection.readyState === WebSocket.OPEN;
}

/** Write one message to the task's bridge socket (there is at most one per task). */
export function send(workflow: WorkflowRuntime, task: TaskRow, message: JsonRpcMessage): void {
  const text = JSON.stringify(message);
  for (const connection of workflow.connections(task.task_id)) {
    if (isOpen(connection)) connection.send(text);
  }
}

/** Dispatch one WebSocket frame from the bridge. */
export async function onBridgeMessage(
  workflow: WorkflowRuntime,
  connection: Connection,
  text: string,
): Promise<void> {
  const message = parseMessage(text);
  if (!message) return;
  const task = servedTask(workflow, connection.state as ConnectionState | null);
  if (!task) return;
  if (isNotification(message))
    return onNotification(workflow, task, message.method, message.params);
  if (isRequest(message)) {
    return onAgentRequest(workflow, connection, task, message.id, message.method, message.params);
  }
  if (isResponse(message))
    return onResponse(workflow, task, message.id, resultOf(message), errorOf(message));
}

async function onNotification(
  workflow: WorkflowRuntime,
  task: TaskRow,
  method: string,
  params: unknown,
): Promise<void> {
  switch (method) {
    case BridgeMethods.hello:
      return onBridgeHello(workflow, task, params as BridgeHelloParams);
    case BridgeMethods.exit:
      return onBridgeExit(workflow, task, params as BridgeExitParams);
    case BridgeMethods.log: {
      const text = (params as BridgeLogParams | undefined)?.text ?? "";
      workflow.log(task.task_id, `bridge: ${text.slice(0, 300)}`);
      return;
    }
    case ClientMethods.sessionUpdate:
      return onSessionUpdate(workflow, task, params as SessionNotification);
    default:
      return;
  }
}

/** Requests from the agent. Permissions are always granted. */
async function onAgentRequest(
  workflow: WorkflowRuntime,
  connection: Connection,
  task: TaskRow,
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<void> {
  if (method !== ClientMethods.sessionRequestPermission) {
    const error = jsonRpcErrorResponse(
      id,
      METHOD_NOT_FOUND,
      `${method} is not supported by the orchestrator client`,
    );
    if (isOpen(connection)) connection.send(JSON.stringify(error));
    return;
  }
  const permission = params as RequestPermissionRequest;
  const optionId = chooseAllowOption(permission.options);
  const label = permission.toolCall.title ?? permission.toolCall.kind ?? "?";
  workflow.log(task.task_id, `permission: ${label} -> ${optionId}`);
  const result: RequestPermissionResponse = {
    outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
  };
  if (isOpen(connection)) connection.send(JSON.stringify(jsonRpcResponse(id, result)));
}

/** Responses to our requests, matched by the purpose stored when the request was sent. */
async function onResponse(
  workflow: WorkflowRuntime,
  task: TaskRow,
  id: JsonRpcId | null,
  result: unknown,
  error?: JsonRpcError,
): Promise<void> {
  if (id === null) {
    const detail = error ? `${error.code}: ${error.message}` : "no error body";
    workflow.log(task.task_id, `session error without request id (${detail})`);
    return;
  }
  const pending = workflow.store.takeRpc(Number(id), task.task_id);
  if (!pending) return;
  if (error) return onRpcError(workflow, task, pending.purpose, pending.method, error);
  switch (pending.purpose) {
    case "initialize":
      return onInitialized(workflow, task, result as InitializeResponse);
    case "session_new":
      return onSessionNew(workflow, task, result as NewSessionResponse);
    case "set_effort":
      return onEffortSet(workflow, task, result as SetSessionConfigOptionResponse);
    case "prompt": {
      const prompt = result as PromptResponse;
      return onTurnEnd(workflow, workflow.store.requireTask(task.task_id), prompt.stopReason);
    }
    case "cancel":
      return;
  }
}

/** Seconds a closed bridge gets to come back before the turn it carried counts as lost. */
export function bridgeLossGraceSeconds(): number {
  return Math.ceil(RECONNECT_CEILING_MS / 1000) + 1;
}

/** The wake text a harness resumes with after its sandbox died under a turn. */
export const LOST_SANDBOX_TEXT =
  "Your sandbox went away in the middle of your last turn. Work that was not committed and pushed is gone. Read the branch and your artifact, then continue the work you were doing.";

/**
 * The bridge socket closed. Remember when, so a queued prompt knows how long to wait. A close
 * under a prompt in flight recovers the turn at once when the bridge process is gone, and
 * otherwise arms the lost-turn alarm. A socket of an older generation is ignored.
 */
export async function onBridgeClosed(
  workflow: WorkflowRuntime,
  closed: ConnectionState,
): Promise<void> {
  const task = servedTask(workflow, closed);
  if (!task) return;
  const taskId = task.task_id;
  const sandbox = workflow.store.requireSandbox(taskId);
  workflow.store.updateSandbox(taskId, {
    bridge_closed_at: new Date(workflow.now()).toISOString(),
  });
  workflow.log(taskId, "bridge disconnected");
  if (!sandbox.prompt_in_flight || isTaskFinished(task.status)) return;
  const alarm: GenerationAlarm = { task_id: taskId, generation: sandbox.generation };
  if (await bridgeProcessGone(workflow, task, sandbox.generation)) {
    return onBridgeLost(workflow, alarm);
  }
  await workflow.scheduleAlarm(bridgeLossGraceSeconds(), "onBridgeLost", alarm);
}

/**
 * True when the task has no open socket and its sandbox reports that the bridge process of the
 * generation ended, so a reconnect cannot come. A failed check counts as a running bridge.
 */
export async function bridgeProcessGone(
  workflow: WorkflowRuntime,
  task: TaskRow,
  generation: number,
): Promise<boolean> {
  if (workflow.connections(task.task_id).length > 0) return false;
  try {
    if (await workflow.sandbox().bridgeRunning(sandboxRefOf(task), generation)) return false;
  } catch (error) {
    const reason = String(error).slice(0, LOGGED_ERROR_CHARS);
    workflow.log(task.task_id, `bridge process check failed: ${reason}`);
    return false;
  }
  workflow.log(task.task_id, "bridge process is gone. not waiting for a reconnect.");
  return true;
}

/**
 * Alarm: the reconnect window closed on a bridge that carried a prompt. The turn is lost and
 * the sandbox restarts with it.
 */
export async function onBridgeLost(
  workflow: WorkflowRuntime,
  alarm: GenerationAlarm,
): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  const sandbox = workflow.store.sandbox(alarm.task_id);
  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;
  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at !== null) return;
  if (workflow.connections(task.task_id).length > 0) return;
  await recoverLostTurn(workflow, task);
}

/**
 * Forget the turn the dead sandbox was running and start the sandbox again. A prompt already
 * queued is what the harness resumes with.
 */
export async function recoverLostTurn(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  workflow.log(task.task_id, "bridge lost with a prompt in flight. restarting the sandbox.");
  workflow.store.clearRpc(task.task_id);
  workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0, turn_text: "" });
  if (!workflow.store.peekPrompt(task.task_id)) {
    workflow.store.enqueuePrompt(task.task_id, LOST_SANDBOX_TEXT);
  }
  await drainQueue(workflow, workflow.store.requireTask(task.task_id));
}
