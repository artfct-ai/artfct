import type { ProcessResult } from "../process";

/** What one preflight check found. */
export type CheckOutcome =
  | { outcome: "passed"; detail: string }
  | { outcome: "failed"; problems: string[] };

/** A check's outcome under the check's name. */
export type CheckReport = CheckOutcome & { check: string };

/** Run a wrangler command in the deployment repo. */
export type RunWrangler = (args: string[]) => Promise<ProcessResult>;

/** Everything the checks reach outside the process. */
export type CheckEnvironment = { repoDir: string; runWrangler: RunWrangler };
