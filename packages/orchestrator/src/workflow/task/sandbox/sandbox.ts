import type { CommitAuthor } from "@artfct-ai/adapters/code/types";
import { harnessSkillFiles } from "@artfct-ai/adapters/harness/skills";
import type {
  Effort,
  GatewayRoutes,
  HarnessAdapter,
  Skill,
} from "@artfct-ai/adapters/harness/types";
import { bridgeDialUrl } from "../harness/bridge-path";
import { LOGGED_ERROR_CHARS, loggedFailureReason } from "../harness/turn";
import { artifactCapability, cliEnv, cloneUrl } from "../../../clients";
import { registeredConfig } from "../../../config/register-config";
import { loadHarnessSkills } from "../../../config/skills";
import { newToken } from "../../../ids";
import type { Adapters } from "../../../config/adapters";
import type { ResolvedStage } from "../../../config/stage";
import type { AllReposReadToken, SandboxStartSpec } from "../../../sandbox/spec";
import { armTokenRefresh, hostCredential, mintSandboxGithubTokens } from "./credential";
import { flushBoards } from "../../board/board";
import { bindWorkflow, failTask, MAX_RESTARTS, restartOrFailTask } from "../../lifecycle";
import { runModelAuthorTurn } from "../model-author";
import type { WorkflowRuntime } from "../../types";
import { taskSettings } from "../settings";
import type { JobRow, SandboxRow, TaskRow } from "../../store/tasks";
import { sandboxRefOf, sandboxSizeOf } from "./size";

/** Where every sandbox clones the repository and every harness runs. */
export const WORKSPACE = "/workspace/repo";
const HELLO_TIMEOUT_S = 90;

/**
 * The sandbox starts awaited now, per runtime, each keyed by its task and generation. It dies with
 * the isolate, which is how a hello timeout tells a slow start from one a restart of the Durable
 * Object cut off.
 */
const startsInFlight = new WeakMap<WorkflowRuntime, Set<string>>();

function sandboxStartKey(taskId: string, generation: number): string {
  return `${taskId}#${generation}`;
}

/** True while this instance awaits the start of the task's sandbox in `generation`. */
export function sandboxStartInFlight(
  workflow: WorkflowRuntime,
  taskId: string,
  generation: number,
): boolean {
  return startsInFlight.get(workflow)?.has(sandboxStartKey(taskId, generation)) ?? false;
}

/**
 * Alarm handler: start a queued task. A task of a stage the workflow definition dropped fails
 * instead. The binding of the job's branch is written again first, since a router write of the
 * job start may have failed.
 */
export async function provision(workflow: WorkflowRuntime, taskId: string): Promise<void> {
  const task = workflow.store.task(taskId);
  if (!task || task.status !== "queued") return;
  const job = workflow.store.requireJob(task.job_id);
  if (!workflow.workflowDefinition().stages.some((declared) => declared.name === job.stage)) {
    return failTask(workflow, task, `Stage ${job.stage} is not in the workflow definition.`);
  }
  if (!(await bindBranchOfJob(workflow, task, job))) return;
  const bound = workflow.store.requireTask(taskId);
  if (bound.status !== "queued") return;
  if (!workflow.store.sandbox(taskId)) return runModelAuthorTurn(workflow, bound);
  await startSandbox(workflow, bound, false);
}

/**
 * Write the binding of the job's branch, so pushes to it route to the workflow. A failed write
 * counts a restart and provisions the task again, or fails it once its restarts are used up.
 * True when the task may start.
 */
async function bindBranchOfJob(
  workflow: WorkflowRuntime,
  task: TaskRow,
  job: JobRow,
): Promise<boolean> {
  const repo = workflow.store.workflowRow()?.repo;
  if (!job.branch || !repo) return true;
  try {
    await bindWorkflow(workflow, { source: "code_branch", repo, branch: job.branch });
    return true;
  } catch (error) {
    workflow.log(
      task.task_id,
      `branch binding failed: ${String(error).slice(0, LOGGED_ERROR_CHARS)}`,
    );
    const current = workflow.store.requireTask(task.task_id);
    if (current.status !== "queued") return false;
    if (current.restarts >= MAX_RESTARTS) {
      await failTask(workflow, current, loggedFailureReason(task.task_id, "The branch binding"));
      return false;
    }
    workflow.store.updateTask(task.task_id, { restarts: current.restarts + 1 });
    await workflow.scheduleAlarm(0, "provision", { task_id: task.task_id });
    return false;
  }
}

/**
 * Arm the provision alarm of every unpaused task that waits queued. A restart writes its task
 * queued before the old container goes, so a new instance starts the sandbox that a restart of
 * the Durable Object cut off. A paused task waits for its resume.
 */
export async function provisionQueuedTasks(workflow: WorkflowRuntime): Promise<void> {
  for (const task of workflow.store.tasks()) {
    if (task.status !== "queued" || task.paused_at !== null) continue;
    await workflow.scheduleAlarm(0, "provision", { task_id: task.task_id });
  }
}

/**
 * Start the task's sandbox again on its branch, in its container when it still has one. The
 * harness resumes with its oldest queued prompt. Counts the restart.
 */
export async function restartSandbox(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  const { restarts } = workflow.store.requireTask(task.task_id);
  workflow.store.updateTask(task.task_id, { status: "queued", restarts: restarts + 1 });
  await startSandbox(workflow, workflow.store.requireTask(task.task_id), true);
}

/**
 * Start or restart the sandbox for a task. Each start is a new generation with a fresh token.
 * The boards show the task provisioning before the start is awaited.
 */
export async function startSandbox(
  workflow: WorkflowRuntime,
  task: TaskRow,
  resume: boolean,
): Promise<void> {
  const fresh = await beginGeneration(workflow, task);
  const { generation } = workflow.store.requireSandbox(fresh.task_id);
  const key = sandboxStartKey(fresh.task_id, generation);
  const starting = startsInFlight.get(workflow) ?? new Set<string>();
  startsInFlight.set(workflow, starting);
  starting.add(key);
  try {
    await startGeneration(workflow, fresh, resume);
  } finally {
    starting.delete(key);
  }
}

async function startGeneration(
  workflow: WorkflowRuntime,
  fresh: TaskRow,
  resume: boolean,
): Promise<void> {
  const config = workflow.config();
  await flushBoards(workflow, fresh.job_id);
  const sandbox = workflow.store.requireSandbox(fresh.task_id);
  const job = workflow.store.requireJob(fresh.job_id);
  const stage = workflow.stageForTask(fresh);
  const settings = taskSettings(workflow, fresh);
  const githubTokens = await mintSandboxGithubTokens(workflow, fresh);
  const hostEnv = cliEnv({
    capability: artifactCapability(stage.artifact),
    adapters: config.adapters,
    credential: await hostCredential(
      workflow,
      fresh,
      async () => githubTokens?.workflowRepoToken ?? null,
    ),
    log: (line) => workflow.log(fresh.task_id, line),
  });
  let commitAuthor: CommitAuthor | null;
  try {
    commitAuthor = workflow.store.workflowRow()?.repo
      ? ((await workflow.code()?.commitAuthor()) ?? null)
      : null;
  } catch (error) {
    workflow.log(
      fresh.task_id,
      `commit author lookup failed: ${String(error).slice(0, LOGGED_ERROR_CHARS)}`,
    );
    if (generationMoved(workflow, sandbox)) return;
    return restartOrFailTask(
      workflow,
      fresh,
      loggedFailureReason(fresh.task_id, "The commit author lookup"),
    );
  }
  let gateway: GatewayRoutes | null;
  let skills: Skill[];
  try {
    gateway = gatewayRouting(workflow, fresh, job);
    skills = loadHarnessSkills(settings.skill);
  } catch (error) {
    if (generationMoved(workflow, sandbox)) return;
    return failTask(workflow, fresh, String(error).slice(0, 500));
  }
  const built = buildStartSpec({
    task: fresh,
    job,
    sandbox,
    stage,
    effort: settings.effort,
    skills,
    harness: workflow.harness(sandbox.harness),
    adapters: config.adapters,
    workflowId: workflow.store.requireWorkflowRow().workflow_id,
    publicUrl: workflow.env.PUBLIC_URL ?? "",
    repo: workflow.store.workflowRow()?.repo ?? null,
    commitAuthor,
    workflowRepoToken: githubTokens?.workflowRepoToken ?? null,
    allReposReadToken: githubTokens?.allReposReadToken ?? null,
    hostEnv,
    gateway,
    sleepAfterMs: config.orchestrator.sandbox.sleep_after,
    startupTimeoutMs: config.orchestrator.sandbox.startup_timeout,
  });
  if ("error" in built) {
    if (generationMoved(workflow, sandbox)) return;
    return failTask(workflow, fresh, built.error);
  }
  try {
    await workflow.sandbox().start(built.spec);
  } catch (error) {
    workflow.log(
      fresh.task_id,
      `sandbox start failed: ${String(error).slice(0, LOGGED_ERROR_CHARS)}`,
    );
    if (generationMoved(workflow, sandbox)) return;
    return restartOrFailTask(
      workflow,
      fresh,
      loggedFailureReason(fresh.task_id, "The sandbox start"),
    );
  }
  workflow.log(fresh.task_id, `sandbox started gen=${sandbox.generation} resume=${resume}`);
  await armHelloTimeout(workflow, workflow.store.requireSandbox(fresh.task_id));
  if (githubTokens)
    await armTokenRefresh(
      workflow,
      workflow.store.requireSandbox(fresh.task_id),
      githubTokens.expiresAt,
    );
}

/** True when a stop or a later start began another generation while this start awaited. */
function generationMoved(workflow: WorkflowRuntime, started: SandboxRow): boolean {
  return workflow.store.requireSandbox(started.task_id).generation !== started.generation;
}

/** Bump the generation, issue a bridge token, and forget the old harness session, rpc rows, keepalive, and nudge. */
async function beginGeneration(workflow: WorkflowRuntime, task: TaskRow): Promise<TaskRow> {
  const sandbox = workflow.store.requireSandbox(task.task_id);
  if (sandbox.keepalive_schedule) await workflow.cancelAlarm(sandbox.keepalive_schedule);
  const generation = sandbox.generation + 1;
  await armHelloTimeout(workflow, { ...sandbox, generation });
  workflow.store.updateTask(task.task_id, { status: "provisioning" });
  workflow.store.updateSandbox(task.task_id, {
    generation,
    bridge_token: newToken(),
    session_id: null,
    prompt_in_flight: 0,
    keepalive_schedule: null,
    bridge_closed_at: null,
    nudged: 0,
  });
  workflow.store.clearRpc(task.task_id);
  return workflow.store.requireTask(task.task_id);
}

/** What `buildStartSpec` needs from the runtime. */
export type StartSpecInput = {
  task: TaskRow;
  job: JobRow;
  sandbox: SandboxRow;
  stage: ResolvedStage;
  effort: Effort | undefined;
  harness: HarnessAdapter;
  skills: readonly Skill[];
  adapters: Adapters;
  workflowId: string;
  publicUrl: string;
  /** The full name of the workflow's repository. Null when the plan did not name one. */
  repo: string | null;
  commitAuthor: CommitAuthor | null;
  workflowRepoToken: string | null;
  allReposReadToken: AllReposReadToken | null;
  /** The environment a CLI in the sandbox reads the host credential of the stage's artifact from. */
  hostEnv: Record<string, string>;
  gateway: GatewayRoutes | null;
  sleepAfterMs: number;
  startupTimeoutMs: number;
};

/**
 * The sandbox start spec for a task, or the reason it cannot be built. Pure. Only a stage with
 * `branch: true` refuses to start without a repository and a job branch.
 */
export function buildStartSpec(
  input: StartSpecInput,
): { spec: SandboxStartSpec } | { error: string } {
  const { task, job, sandbox, stage, repo } = input;
  if (stage.branch && (!repo || !job.branch)) {
    return { error: "stage needs a repository but none is known" };
  }
  const setup = input.harness.setup({
    model: task.model,
    effort: input.effort ?? null,
    repoFull: repo,
    gateway: input.gateway,
  });
  if ("error" in setup) return { error: setup.error };
  const skills = harnessSkillFiles(input.harness, input.skills);
  const spec: SandboxStartSpec = {
    sandbox_id: task.task_id,
    size: sandboxSizeOf(task.role),
    workflow_id: input.workflowId,
    task_id: task.task_id,
    harness: sandbox.harness,
    model: task.model,
    dial_url: bridgeDialUrl(input.publicUrl, input.workflowId, task.task_id),
    token: sandbox.bridge_token,
    generation: sandbox.generation,
    workspace: WORKSPACE,
    repo: repo
      ? {
          clone_url: cloneUrl(input.adapters, repo),
          branch: job.branch,
          author: input.commitAuthor,
        }
      : null,
    workflow_repo_token: input.workflowRepoToken,
    all_repos_read_token: input.allReposReadToken,
    env: {
      ...buildSandboxEnv({
        workflowId: input.workflowId,
        taskId: task.task_id,
        stageName: job.stage,
        repoFull: repo,
      }),
      ...input.hostEnv,
      ...setup.env,
    },
    files: [
      ...setup.files,
      { path: input.harness.instructionsFile, content: `${registeredConfig().writingRules}\n` },
      ...skills,
    ],
    setup_commands: setup.commands,
    sleep_after_ms: input.sleepAfterMs,
    startup_timeout_ms: input.startupTimeoutMs,
  };
  return { spec };
}

/** Arm the hello timeout of the task's generation in place of the one it holds. */
export async function armHelloTimeout(
  workflow: WorkflowRuntime,
  sandbox: SandboxRow,
): Promise<void> {
  if (sandbox.hello_schedule) await workflow.cancelAlarm(sandbox.hello_schedule);
  const scheduleId = await workflow.scheduleAlarm(HELLO_TIMEOUT_S, "onHelloTimeout", {
    task_id: sandbox.task_id,
    generation: sandbox.generation,
  });
  workflow.store.updateSandbox(sandbox.task_id, { hello_schedule: scheduleId });
}

/**
 * The routes the harness sends model calls on, tagged with the task and the stage of its job.
 * Null without the gateway's secrets. Throws when the gateway cannot carry the model.
 */
function gatewayRouting(
  workflow: WorkflowRuntime,
  task: TaskRow,
  job: JobRow,
): GatewayRoutes | null {
  const gateway = workflow.gateway(workflow.config().adapters.gateway.provider);
  if (!gateway) return null;
  const metadata = {
    workflow_id: workflow.store.requireConversation().conversation_id,
    task_id: task.task_id,
    stage: job.stage,
  };
  return {
    anthropic: gateway.anthropicRoute(metadata),
    compat: gateway.compatRoute(task.model, metadata),
  };
}

/** Inputs for the environment variables every sandbox starts with. */
type SandboxEnvInput = {
  workflowId: string;
  taskId: string;
  stageName: string;
  repoFull: string | null;
};

/**
 * The environment every harness process shares: task identity and the repository. The task
 * credential is written to a file instead, since env is frozen at process start.
 */
export function buildSandboxEnv(input: SandboxEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    ARTFCT_TASK_ID: input.taskId,
    ARTFCT_WORKFLOW_ID: input.workflowId,
    ARTFCT_STAGE: input.stageName,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (input.repoFull) env.ARTFCT_REPO = input.repoFull;
  return env;
}

/** Cancel the task's alarms and forget their ids. */
export async function clearTaskTimers(
  workflow: WorkflowRuntime,
  sandbox: SandboxRow,
): Promise<void> {
  const ids = [
    sandbox.no_progress_schedule,
    sandbox.wall_schedule,
    sandbox.hello_schedule,
    sandbox.keepalive_schedule,
    sandbox.token_schedule,
  ];
  for (const id of ids) if (id) await workflow.cancelAlarm(id);
  workflow.store.updateSandbox(sandbox.task_id, {
    no_progress_schedule: null,
    wall_schedule: null,
    hello_schedule: null,
    keepalive_schedule: null,
    token_schedule: null,
  });
}

/**
 * Close the task's bridge sockets and destroy its container. The row, its status, and its
 * queued prompts stay. The harness session goes with the container, so the next prompt starts
 * a new sandbox rather than waiting for a bridge that will not come back. The bridge token is
 * replaced, so a copy taken from the container cannot dial in again. Failures are logged.
 */
export async function closeContainer(
  workflow: WorkflowRuntime,
  task: TaskRow,
  reason: string,
): Promise<void> {
  for (const connection of workflow.connections(task.task_id)) {
    connection.close(1000, reason);
  }
  workflow.store.updateSandbox(task.task_id, { session_id: null, bridge_token: newToken() });
  try {
    await workflow.sandbox().destroy(sandboxRefOf(task));
  } catch (error) {
    workflow.log(task.task_id, `sandbox destroy failed: ${String(error).slice(0, 200)}`);
  }
}

/** Close the task's container and drop the prompts it will never run. For teardown. */
export async function destroySandbox(workflow: WorkflowRuntime, task: TaskRow): Promise<void> {
  workflow.store.clearPromptQueue(task.task_id);
  await closeContainer(workflow, task, "task finished");
}
