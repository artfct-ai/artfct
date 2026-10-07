import type { ProcessResult } from "../process";

/** What one preflight check found. Only a failed check fails `artfct check`. */
export type CheckOutcome =
  | { outcome: "passed"; detail: string }
  | { outcome: "skipped"; detail: string }
  | { outcome: "warned"; problems: string[] }
  | { outcome: "failed"; problems: string[] };

/** A check's outcome under the check's name. */
export type CheckReport = CheckOutcome & { check: string };

/** Run a wrangler command in the deployment repo. */
export type RunWrangler = (args: string[]) => Promise<ProcessResult>;

/** Everything the checks reach outside the process. `runWrangler` is null under `--offline`. */
export type CheckEnvironment = { repoDir: string; runWrangler: RunWrangler | null };
