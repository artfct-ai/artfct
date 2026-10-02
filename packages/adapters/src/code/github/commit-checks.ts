/** The pure reading of GitHub's check runs, check suites, and commit statuses as one answer. */

import type { CheckFailure, CommitChecks } from "../types";

/** One check run as `GET /commits/{ref}/check-runs` lists it. It lists the latest run per name. */
export type CommitCheckRunPayload = {
  name: string;
  conclusion: string | null;
  completed_at: string | null;
  html_url: string | null;
  output: { title: string | null; summary: string | null };
};

/** One check suite as `GET /commits/{ref}/check-suites` lists it. */
export type CheckSuitePayload = { status: string | null; latest_check_runs_count: number };

/** One commit status as the combined status lists it, the latest per context. */
export type CommitStatusPayload = {
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
  updated_at: string;
};

/** Everything GitHub holds about the checks of one commit. */
export type GithubCommitChecksInput = {
  runs: CommitCheckRunPayload[];
  suites: CheckSuitePayload[];
  statuses: CommitStatusPayload[];
};

/** One check of either form, as far as the answer needs it. */
type ReportedCheck =
  | { standing: "passed"; settled_at: string | null }
  | { standing: "running" }
  | { standing: "failed" | "stopped"; failure: CheckFailure };

const RUN_STANDINGS: Record<string, "passed" | "failed"> = {
  success: "passed",
  neutral: "passed",
  skipped: "passed",
  failure: "failed",
  timed_out: "failed",
};

/** How much of what a check said about its failure the author is sent. */
const DETAIL_CHARS = 2000;

/**
 * What the checks on one commit say together. A failure is said at once, while other checks
 * still run. A suite that is not completed counts as running even when each of its runs so far
 * is, because its next job may not exist yet. GitHub opens a suite for every installed App,
 * so a suite without a run is not a check.
 */
export function githubCommitChecks(input: GithubCommitChecksInput): CommitChecks {
  const reported = [...input.runs.map(reportedRun), ...input.statuses.map(reportedStatus)];
  const failed = failuresOf(reported, "failed");
  if (failed.length) return { state: "failed", failures: failed };
  const stopped = failuresOf(reported, "stopped");
  if (stopped.length) return { state: "stopped", failures: stopped };
  if (reported.some((check) => check.standing === "running")) return { state: "running" };
  if (input.suites.some(suiteRuns)) return { state: "running" };
  const settledAt = reported
    .flatMap((check) => (check.standing === "passed" && check.settled_at ? [check.settled_at] : []))
    .toSorted((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1);
  return settledAt ? { state: "passed", settled_at: settledAt } : { state: "unreported" };
}

function failuresOf(reported: ReportedCheck[], standing: "failed" | "stopped"): CheckFailure[] {
  return reported.flatMap((check) => (check.standing === standing ? [check.failure] : []));
}

function suiteRuns(suite: CheckSuitePayload): boolean {
  return suite.latest_check_runs_count > 0 && suite.status !== "completed";
}

/** A run with no conclusion yet is running. A conclusion a code change cannot fix is stopped. */
function reportedRun(run: CommitCheckRunPayload): ReportedCheck {
  if (run.conclusion === null) return { standing: "running" };
  const standing = RUN_STANDINGS[run.conclusion] ?? "stopped";
  if (standing === "passed") return { standing, settled_at: run.completed_at };
  const detail = [run.output.title, run.output.summary].filter(Boolean).join("\n");
  return {
    standing,
    failure: {
      name: run.name,
      conclusion: run.conclusion,
      detail: detail.slice(0, DETAIL_CHARS),
      url: run.html_url,
    },
  };
}

/** A status in the `error` state says its system broke, which a code change cannot fix. */
function reportedStatus(status: CommitStatusPayload): ReportedCheck {
  if (status.state === "pending") return { standing: "running" };
  if (status.state === "success") return { standing: "passed", settled_at: status.updated_at };
  return {
    standing: status.state === "failure" ? "failed" : "stopped",
    failure: {
      name: status.context,
      conclusion: status.state,
      detail: (status.description ?? "").slice(0, DETAIL_CHARS),
      url: status.target_url,
    },
  };
}
