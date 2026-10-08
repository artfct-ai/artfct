import type { HarnessFile } from "@artfct-ai/adapters/harness/types";
import { getSandbox, type ISandbox } from "@cloudflare/sandbox";
import type { Env } from "../env";
import type { SandboxProvider } from "./provider";
import {
  ALL_REPOS_READ_TOKEN_FILE,
  GITHUB_TOKEN_DIR,
  WORKFLOW_REPO_TOKEN_FILE,
  bridgeCommand,
  bridgeEnv,
  githubAuthScript,
  startupScript,
  type AllReposReadToken,
  type SandboxRef,
  type SandboxSize,
  type SandboxStartSpec,
} from "./spec";

const AUTH_TIMEOUT_MS = 60_000;

/** The Sandbox SDK methods the provider calls. Tests pass a fake with the same shape. */
export type SandboxHandle = Pick<
  ISandbox,
  "setEnvVars" | "writeFile" | "exec" | "startProcess" | "mkdir" | "listProcesses"
> & {
  readFile(path: string, options: { encoding: "utf-8" }): Promise<{ content: string }>;
  destroy(): Promise<void>;
};

/** Sleep options as passed to the Sandbox SDK. */
export type SleepOptions = { keepAlive?: boolean; sleepAfter?: string };

/** Opens the stub of one sandbox. The default wraps `getSandbox`. */
export type SandboxHandleFactory = (sandbox: SandboxRef, options: SleepOptions) => SandboxHandle;

/**
 * Runs sandboxes on Cloudflare Containers through the Sandbox SDK. Every call on the sandbox
 * stub renews its `sleepAfter` deadline. The bridge socket does not.
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  private getHandle: SandboxHandleFactory;

  constructor(env: Env, getHandle?: SandboxHandleFactory) {
    this.getHandle =
      getHandle ??
      ((sandbox, options) => getSandbox(sandboxNamespace(env, sandbox.size), sandbox.id, options));
  }

  async start(spec: SandboxStartSpec): Promise<void> {
    const sandbox = this.handle({ id: spec.sandbox_id, size: spec.size }, spec.sleep_after_ms);
    const env = { ...spec.env, ...(spec.repo ? { ARTFCT_CLONE_URL: spec.repo.clone_url } : {}) };
    await sandbox.setEnvVars(env);
    if (spec.workflow_repo_token)
      await writeTokens(sandbox, spec.workflow_repo_token, spec.all_repos_read_token);
    for (const file of spec.files) await writeHarnessFile(sandbox, file);
    await sandbox.writeFile("/tmp/artfct-startup.sh", startupScript(spec));
    const setup = await sandbox.exec("bash /tmp/artfct-startup.sh", {
      timeout: spec.startup_timeout_ms,
    });
    if (!setup.success) throw new Error(`sandbox startup failed: ${setup.stderr.slice(-2000)}`);
    await sandbox.startProcess(bridgeCommand(spec), { cwd: spec.workspace, env: bridgeEnv(spec) });
  }

  async setEnv(sandbox: SandboxRef, env: Record<string, string>): Promise<void> {
    await this.handle(sandbox).setEnvVars(env);
  }

  async refreshGithubTokens(
    sandbox: SandboxRef,
    token: string,
    read: AllReposReadToken | null,
  ): Promise<void> {
    const handle = this.handle(sandbox);
    await writeTokens(handle, token, read);
    await handle.writeFile("/tmp/artfct-github-auth.sh", githubAuthScript(read));
    const result = await handle.exec("bash /tmp/artfct-github-auth.sh", {
      timeout: AUTH_TIMEOUT_MS,
    });
    if (!result.success) throw new Error(`github auth failed: ${result.stderr.slice(-500)}`);
  }

  async keepAlive(sandbox: SandboxRef): Promise<void> {
    await this.handle(sandbox).listProcesses();
  }

  async readFile(sandbox: SandboxRef, path: string): Promise<string> {
    const file = await this.handle(sandbox).readFile(path, { encoding: "utf-8" });
    return file.content;
  }

  async destroy(sandbox: SandboxRef): Promise<void> {
    await this.handle(sandbox).destroy();
  }

  private handle(sandbox: SandboxRef, sleepAfterMs?: number): SandboxHandle {
    return this.getHandle(sandbox, sleepOptions(sleepAfterMs));
  }
}

/** The Durable Object namespace whose containers run on the instance type of a size. */
function sandboxNamespace(env: Env, size: SandboxSize): Env["Sandbox"] {
  const namespaces: Record<SandboxSize, Env["Sandbox"]> = {
    small: env.Sandbox,
    large: env.SandboxLarge,
  };
  return namespaces[size];
}

/** Write the GitHub token files. The startup and auth scripts restrict their mode. */
async function writeTokens(
  sandbox: SandboxHandle,
  token: string,
  read: AllReposReadToken | null,
): Promise<void> {
  await sandbox.mkdir(GITHUB_TOKEN_DIR, { recursive: true });
  await sandbox.writeFile(WORKFLOW_REPO_TOKEN_FILE, token);
  if (read) await sandbox.writeFile(ALL_REPOS_READ_TOKEN_FILE, read.token);
}

/** Write one file the harness reads, creating its directory. */
async function writeHarnessFile(sandbox: SandboxHandle, file: HarnessFile): Promise<void> {
  await sandbox.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), { recursive: true });
  await sandbox.writeFile(file.path, file.content);
}

/** Sandbox SDK sleep options for a sleep_after value. 0 keeps the container alive. */
export function sleepOptions(sleepAfterMs?: number): SleepOptions {
  if (sleepAfterMs === undefined) return {};
  if (sleepAfterMs === 0) return { keepAlive: true };
  return { sleepAfter: `${Math.max(1, Math.round(sleepAfterMs / 60_000))}m` };
}
