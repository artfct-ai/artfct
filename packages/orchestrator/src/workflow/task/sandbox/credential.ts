import type { MintedToken, Permissions } from "@artfct-ai/adapters/code/types";
import { isExpiring } from "@artfct-ai/adapters/expiry";
import { artifactCapability, artifactNeedsTaskCredential } from "../../../clients";
import { isTaskFinished } from "../../store/state";
import type { SandboxRow, TaskRow } from "../../store/tasks";
import type { TaskAlarm } from "../harness/timers";
import type { WorkflowRuntime } from "../../types";
import { sandboxRefOf } from "./size";

/** How long before a credential dies the sandbox gets a new one. */
export const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Mint the credential a task's sandbox runs with. It reaches the workflow's repository alone.
 * An author gets every permission the host grants there, a reviewer what its artifact kind
 * allows. Null when the workflow has no repository, or when none can be minted.
 */
export async function taskCredential(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<MintedToken | null> {
  const code = workflow.code();
  const repo = workflow.state.repo?.full;
  if (!code || !repo) return null;
  const permissions = task.role === "reviewer" ? reviewerPermissions(workflow, task) : undefined;
  try {
    const minted = await code.mintToken(repo, permissions);
    return minted.token ? minted : null;
  } catch (error) {
    workflow.log(task.task_id, `credential mint failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * The credential the host of the task's artifact takes. A host that runs on the task's own
 * credential gets the one `taskToken` gives. Any other host gets the deployment's.
 */
export async function hostCredential(
  workflow: WorkflowRuntime,
  task: TaskRow,
  taskToken: () => Promise<string | null>,
): Promise<string | null> {
  const kind = workflow.stageForTask(task).artifact;
  if (artifactNeedsTaskCredential(kind, workflow.config().providers)) return taskToken();
  return workflow.mcpCredential(artifactCapability(kind));
}

/** What a reviewer of this task's stage may do. Undefined when its kind narrows nothing. */
function reviewerPermissions(workflow: WorkflowRuntime, task: TaskRow): Permissions | undefined {
  const kind = workflow.stageForTask(task).artifact;
  return workflow.artifact(kind).review?.reviewerCredential ?? undefined;
}

/** True when the credential the sandbox holds is inside the refresh margin, or already dead. */
export function credentialExpiring(sandbox: SandboxRow, nowMs: number): boolean {
  if (!sandbox.credential_expires_at) return false;
  return isExpiring(Date.parse(sandbox.credential_expires_at), nowMs, CREDENTIAL_REFRESH_MARGIN_MS);
}

/** Seconds until the next try after the host refused to mint or the sandbox refused the write. */
export const TOKEN_RETRY_S = 60;

/**
 * Write the credential the sandbox started with into the sandbox row and arm the refresh for
 * just before it dies.
 */
export async function armTokenRefresh(
  workflow: WorkflowRuntime,
  sandbox: SandboxRow,
  expiresAt: number,
): Promise<void> {
  if (sandbox.token_schedule) await workflow.cancelAlarm(sandbox.token_schedule);
  const seconds = Math.ceil((expiresAt - workflow.now() - CREDENTIAL_REFRESH_MARGIN_MS) / 1000);
  const alarm: TaskAlarm = { task_id: sandbox.task_id };
  const scheduleId = await workflow.scheduleAlarm(
    Math.max(seconds, TOKEN_RETRY_S),
    "refreshToken",
    alarm,
  );
  workflow.store.updateSandbox(sandbox.task_id, {
    credential_expires_at: new Date(expiresAt).toISOString(),
    token_schedule: scheduleId,
  });
}

/**
 * Alarm: the sandbox's credential is about to die. Mint a new one and rewrite it. A sandbox
 * with no bridge connection is left alone until its next hello.
 */
export async function refreshToken(workflow: WorkflowRuntime, alarm: TaskAlarm): Promise<void> {
  const task = workflow.store.task(alarm.task_id);
  if (!task || !workflow.code() || isTaskFinished(task.status)) return;
  if (workflow.connections(task.task_id).length === 0) {
    workflow.log(task.task_id, "credential refresh waits: the sandbox has no bridge connection");
    workflow.store.updateSandbox(task.task_id, { token_schedule: null });
    return;
  }
  await refreshSandboxToken(workflow, task);
}

/**
 * Mint a credential and write it into the running sandbox now, arming the next refresh or a
 * retry. True when the sandbox holds a fresh credential after this.
 */
export async function refreshSandboxToken(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<boolean> {
  const minted = await taskCredential(workflow, task);
  if (minted) {
    try {
      await workflow.sandbox().refreshGithubToken(sandboxRefOf(task), minted.token);
      workflow.log(task.task_id, "credential refreshed in the sandbox");
      await armTokenRefresh(
        workflow,
        workflow.store.requireSandbox(task.task_id),
        minted.expiresAt,
      );
      return true;
    } catch (error) {
      workflow.log(task.task_id, `credential refresh failed: ${String(error).slice(0, 200)}`);
    }
  }
  await armTokenRetry(workflow, workflow.store.requireSandbox(task.task_id));
  return false;
}

async function armTokenRetry(workflow: WorkflowRuntime, sandbox: SandboxRow): Promise<void> {
  if (sandbox.token_schedule) await workflow.cancelAlarm(sandbox.token_schedule);
  const alarm: TaskAlarm = { task_id: sandbox.task_id };
  const scheduleId = await workflow.scheduleAlarm(TOKEN_RETRY_S, "refreshToken", alarm);
  workflow.store.updateSandbox(sandbox.task_id, { token_schedule: scheduleId });
}
