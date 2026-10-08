import type {
  InitializeRequest,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  AgentMethods,
  type BridgeExitParams,
  type BridgeHelloParams,
} from "@artfct-ai/acp/methods";
import type { Effort } from "@artfct-ai/adapters/harness/types";
import { envSecret } from "../../../env";
import { flushBoards } from "../../board/board";
import { sendRequest } from "./bridge";
import {
  credentialExpiring,
  hostCredential,
  refreshSandboxGithubTokens,
  mintWorkflowRepoToken,
} from "../sandbox/credential";
import { harnessMcpServers } from "../sandbox/mcp-servers";
import { failTask } from "../../lifecycle";
import { drainQueue, sendFirstPrompt } from "./prompt-queue";
import { MAX_SANDBOX_RESTARTS, WORKSPACE, restartSandbox } from "../sandbox/sandbox";
import type { WorkflowRuntime } from "../../types";
import { taskSettings } from "../settings";
import { isTaskFinished } from "../../store/state";
import type { TaskRow } from "../../store/tasks";

/**
 * The bridge is up. A reconnect that still holds its harness session needs no handshake, only a
 * credential when its own ran out. A fresh bridge drops the old harness session and its rpc rows.
 */
export async function onBridgeHello(
  workflow: WorkflowRuntime,
  task: TaskRow,
  hello: BridgeHelloParams,
): Promise<void> {
  workflow.log(task.task_id, `hello fresh=${hello.fresh} harness=${hello.harness}`);
  const sandbox = workflow.store.requireSandbox(task.task_id);
  if (sandbox.hello_schedule) await workflow.cancelAlarm(sandbox.hello_schedule);
  workflow.store.updateSandbox(task.task_id, { hello_schedule: null, bridge_closed_at: null });
  if (task.status === "provisioning") {
    workflow.store.updateTask(task.task_id, { status: "working" });
    await flushBoards(workflow, task.job_id);
  }
  if (sandbox.session_id && !hello.fresh) {
    if (credentialExpiring(sandbox, workflow.now()))
      await refreshSandboxGithubTokens(workflow, task);
    await drainQueue(workflow, workflow.store.requireTask(task.task_id));
    return;
  }
  workflow.store.clearRpc(task.task_id);
  workflow.store.updateSandbox(task.task_id, { session_id: null, prompt_in_flight: 0 });
  const params: InitializeRequest = {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  };
  sendRequest(
    workflow,
    workflow.store.requireTask(task.task_id),
    AgentMethods.initialize,
    params,
    "initialize",
  );
}

/** The harness process died. Restart the sandbox once, then fail. */
export async function onBridgeExit(
  workflow: WorkflowRuntime,
  task: TaskRow,
  exit: BridgeExitParams,
): Promise<void> {
  workflow.log(task.task_id, `harness exited code=${exit.code}`);
  if (isTaskFinished(task.status)) return;
  const { restarts } = workflow.store.requireSandbox(task.task_id);
  if (restarts >= MAX_SANDBOX_RESTARTS) {
    return failTask(workflow, task, `harness exited (code ${exit.code}) with no restarts left`);
  }
  await restartSandbox(workflow, task);
}

/** `initialize` answered. Open the harness session with the stage's MCP servers. */
export async function onInitialized(
  workflow: WorkflowRuntime,
  task: TaskRow,
  initialized: InitializeResponse,
): Promise<void> {
  workflow.log(task.task_id, `initialized protocol=${initialized.protocolVersion}`);
  const params: NewSessionRequest = {
    cwd: WORKSPACE,
    mcpServers: await mcpServers(workflow, task),
  };
  sendRequest(workflow, task, AgentMethods.sessionNew, params, "session_new");
}

/**
 * `session/new` answered. A harness session that holds another effort than the stage asked for is told
 * the asked one first. Otherwise the first prompt goes out.
 */
export async function onSessionNew(
  workflow: WorkflowRuntime,
  task: TaskRow,
  session: NewSessionResponse,
): Promise<void> {
  workflow.store.updateSandbox(task.task_id, { session_id: session.sessionId });
  const fresh = workflow.store.requireTask(task.task_id);
  const asked = taskSettings(workflow, fresh).effort ?? null;
  workflow.log(task.task_id, effortLine(asked, session.configOptions));
  const held = heldEffort(session.configOptions);
  if (!asked || held === undefined || held === asked) return sendFirstPrompt(workflow, fresh);
  const params: SetSessionConfigOptionRequest = {
    sessionId: session.sessionId,
    configId: EFFORT_OPTION,
    value: asked,
  };
  sendRequest(workflow, fresh, AgentMethods.sessionSetConfigOption, params, "set_effort");
}

/** The harness session answered the effort it was told. Log what it holds now and send the first prompt. */
export async function onEffortSet(
  workflow: WorkflowRuntime,
  task: TaskRow,
  response: SetSessionConfigOptionResponse,
): Promise<void> {
  const fresh = workflow.store.requireTask(task.task_id);
  workflow.log(
    task.task_id,
    effortLine(taskSettings(workflow, fresh).effort ?? null, response.configOptions),
  );
  await sendFirstPrompt(workflow, fresh);
}

const EFFORT_OPTION = "effort";

function heldEffort(options: NewSessionResponse["configOptions"] | undefined) {
  return options?.find((option) => option.id === EFFORT_OPTION)?.currentValue;
}

/** The log line for what effort the harness session reports against what the stage asked for. */
export function effortLine(
  asked: Effort | null,
  options: NewSessionResponse["configOptions"] | undefined,
): string {
  const held = heldEffort(options);
  const wanted = asked ? `, asked for ${asked}` : "";
  if (held === undefined) return `session reports no effort option${wanted}`;
  if (!asked) return `session effort=${String(held)}, harness default`;
  if (held === asked) return `session effort=${asked} confirmed`;
  return `session effort=${String(held)}${wanted}`;
}

/**
 * The MCP servers of the harness session: the one the task's artifact kind is worked through,
 * then the customer's. The first is left out when the host has a CLI in its place, and when the
 * host has no credential for it.
 */
async function mcpServers(workflow: WorkflowRuntime, task: TaskRow): Promise<McpServer[]> {
  const kind = workflow.stageForTask(task).artifact;
  const credential = await hostCredential(
    workflow,
    task,
    async () => (await mintWorkflowRepoToken(workflow, task))?.token ?? null,
  );
  return harnessMcpServers({
    provider: workflow.artifact(kind).mcp(credential),
    configured: workflow.config().mcp_servers,
    secret: (name) => envSecret(workflow.env, name),
    log: (line) => workflow.log(task.task_id, line),
  });
}
