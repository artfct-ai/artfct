import {
  branchBindings,
  isOrchestratorBranch,
  NOT_ORCHESTRATOR_BRANCH,
  payloadString,
  type GithubContext,
} from "./inbound-shared";
import type { CodeInbound } from "../types";

/** Checks GitHub ran on a commit no pull request of this repository holds. */
const NO_PULL_REQUEST: CodeInbound = { ignore: "check without a pull request" };

type CheckSuite = {
  conclusion: string | null;
  head_branch: string | null;
  pull_requests: Array<{ number: number }>;
  app?: { name?: string };
};

type CheckRun = {
  name: string;
  conclusion: string | null;
  check_suite?: { head_branch?: string | null };
  pull_requests: Array<{ number: number }>;
  html_url?: string;
  output?: { title?: string | null; summary?: string | null };
};

/**
 * A completed check suite on a pull request of an orchestrator branch becomes `ci_event` with its
 * conclusion.
 */
export async function githubCheckSuiteEvent(context: GithubContext): Promise<CodeInbound> {
  const suite = context.payload.check_suite as CheckSuite;
  const action = payloadString(context.payload, "action");
  if (action !== "completed") {
    return { ignore: `check_suite ${action}` };
  }
  const branch = suite.head_branch;
  if (!branch || !isOrchestratorBranch(branch)) return NOT_ORCHESTRATOR_BRANCH;
  const prNumber = suite.pull_requests[0]?.number;
  if (!prNumber) return NO_PULL_REQUEST;
  return {
    event: {
      id: context.eventId,
      kind: "ci_event",
      actor: null,
      bindings: branchBindings(context.repo, branch, prNumber),
      links: [],
      text: "",
      pull: {
        action: "completed",
        repo: context.repo.full_name,
        number: prNumber,
        branch,
        conclusion: suite.conclusion ?? "unknown",
        check_names: suite.app?.name ? [suite.app.name] : [],
      },
    },
  };
}

/**
 * Only failed or timed out check runs on a pull request are reported. Successes arrive with the
 * suite.
 */
export async function githubCheckRunEvent(context: GithubContext): Promise<CodeInbound> {
  const run = context.payload.check_run as CheckRun;
  const action = payloadString(context.payload, "action");
  if (action !== "completed") {
    return { ignore: `check_run ${action}` };
  }
  const branch = run.check_suite?.head_branch;
  if (!branch || !isOrchestratorBranch(branch)) return NOT_ORCHESTRATOR_BRANCH;
  if (run.conclusion !== "failure" && run.conclusion !== "timed_out") {
    return { ignore: `check_run ${run.conclusion}` };
  }
  const prNumber = run.pull_requests[0]?.number;
  if (!prNumber) return NO_PULL_REQUEST;
  const detail = [run.output?.title, run.output?.summary, run.html_url].filter(Boolean).join("\n");
  return {
    event: {
      id: context.eventId,
      kind: "ci_event",
      actor: null,
      bindings: branchBindings(context.repo, branch, prNumber),
      links: run.html_url ? [run.html_url] : [],
      text: detail,
      pull: {
        action: "completed",
        repo: context.repo.full_name,
        number: prNumber,
        branch,
        conclusion: run.conclusion ?? "unknown",
        check_names: [run.name],
      },
    },
  };
}
