import type { AllReposReadToken, SandboxRef, SandboxStartSpec } from "./spec";

/** Starts, updates, and destroys sandboxes. */
export interface SandboxProvider {
  start(spec: SandboxStartSpec): Promise<void>;
  setEnv(sandbox: SandboxRef, env: Record<string, string>): Promise<void>;
  /** Replace the GitHub tokens the running sandbox uses for git and gh. */
  refreshGithubTokens(
    sandbox: SandboxRef,
    token: string,
    read: AllReposReadToken | null,
  ): Promise<void>;
  /** Touch the sandbox so its inactivity timer starts over. */
  keepAlive(sandbox: SandboxRef): Promise<void>;
  /** Read the text of a file inside the sandbox. A missing file is an error that names the path. */
  readFile(sandbox: SandboxRef, path: string): Promise<string>;
  destroy(sandbox: SandboxRef): Promise<void>;
}
