import type { MintedToken, Permissions } from "@artfct-ai/adapters/code/types";
import { isExpiring } from "@artfct-ai/adapters/expiry";
import { artifactCapability, artifactNeedsTaskCredential } from "../../../clients";
import { isTaskFinished } from "../../store/state";
import type { AllReposReadToken } from "../../../sandbox/spec";
import type { SandboxRow, TaskRow } from "../../store/tasks";
import type { TaskAlarm } from "../harness/timers";
import type { WorkflowRuntime } from "../../types";
import { sandboxRefOf } from "./size";

/** How long before a credential dies the sandbox gets a new one. */
export const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Mint the token the sandbox uses for the workflow's repository. It reaches that repository
 * alone. An author gets every permission the code host grants there, a reviewer what its
 * artifact kind allows. Null when 1) the workflow has no repository 2) minting fails.
 */
export async function mintWorkflowRepoToken(
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

/** The GitHub tokens a task's sandbox holds, and the instant the first of them expires. */
export type SandboxGithubTokens = {
  /** Reaches the workflow's repository with the task's permissions. */
  workflowRepoToken: string;
  /** Reads every repository the code host credential reaches. Null when `read_all_repos` is off. */
  allReposReadToken: AllReposReadToken | null;
  expiresAt: number;
};

/**
 * Mint the GitHub tokens a task's sandbox holds. Null when 1) the workflow has no repository
 * 2) the workflow repo token cannot be minted. When only the all-repos read token fails, the
 * sandbox reaches the workflow's repository alone until the next refresh.
 */
export async function mintSandboxGithubTokens(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<SandboxGithubTokens | null> {
  const workflowRepo = workflow.state.repo?.full;
  const workflowRepoToken = await mintWorkflowRepoToken(workflow, task);
  if (!workflowRepo || !workflowRepoToken) return null;
  const allReposReadToken = await mintAllReposReadToken(workflow, task);
  return {
    workflowRepoToken: workflowRepoToken.token,
    allReposReadToken: allReposReadToken
      ? { token: allReposReadToken.token, workflow_repo: workflowRepo }
      : null,
    expiresAt: Math.min(
      workflowRepoToken.expiresAt,
      allReposReadToken?.expiresAt ?? workflowRepoToken.expiresAt,
    ),
  };
}

/**
 * Mint a read-only token for every repository the code host credential reaches. Null when
 * 1) `read_all_repos` is off 2) minting fails.
 */
async function mintAllReposReadToken(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<MintedToken | null> {
  const code = workflow.code();
  if (!code || !workflow.config().orchestrator.sandbox.read_all_repos) return null;
  try {
    const minted = await code.mintAllReposReadToken();
    return minted.token ? minted : null;
  } catch (error) {
    workflow.log(task.task_id, `all-repos read token mint failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * The credential the host of the task's artifact takes. A host that runs on the workflow repo
 * token gets the one `workflowRepoToken` gives. Any other host gets the deployment's.
 */
export async function hostCredential(
  workflow: WorkflowRuntime,
  task: TaskRow,
  workflowRepoToken: () => Promise<string | null>,
): Promise<string | null> {
  const kind = workflow.stageForTask(task).artifact;
  if (artifactNeedsTaskCredential(kind, workflow.config().adapters)) return workflowRepoToken();
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
  await refreshSandboxGithubTokens(workflow, task);
}

/**
 * Mint the sandbox's GitHub tokens and write them into the running sandbox now, arming the next
 * refresh or a retry. True when the sandbox holds fresh tokens after this.
 */
export async function refreshSandboxGithubTokens(
  workflow: WorkflowRuntime,
  task: TaskRow,
): Promise<boolean> {
  const tokens = await mintSandboxGithubTokens(workflow, task);
  if (tokens) {
    try {
      await workflow
        .sandbox()
        .refreshGithubTokens(
          sandboxRefOf(task),
          tokens.workflowRepoToken,
          tokens.allReposReadToken,
        );
      workflow.log(task.task_id, "credential refreshed in the sandbox");
      await armTokenRefresh(
        workflow,
        workflow.store.requireSandbox(task.task_id),
        tokens.expiresAt,
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
