import type { SandboxRef, SandboxStartSpec } from "./spec";

/** Starts, updates, and destroys sandboxes. */
export interface SandboxProvider {
  start(spec: SandboxStartSpec): Promise<void>;
  setEnv(sandbox: SandboxRef, env: Record<string, string>): Promise<void>;
  /** Replace the GitHub token the running sandbox uses for git and gh. */
  refreshGithubToken(sandbox: SandboxRef, token: string): Promise<void>;
  /** Touch the sandbox so its inactivity timer starts over. */
  keepAlive(sandbox: SandboxRef): Promise<void>;
  /** Whether the bridge process is currently running. */
  bridgeRunning(sandbox: SandboxRef, generation: number): Promise<boolean>;
  /** Read the text of a file inside the sandbox. A missing file is an error that names the path. */
  readFile(sandbox: SandboxRef, path: string): Promise<string>;
  destroy(sandbox: SandboxRef): Promise<void>;
}
