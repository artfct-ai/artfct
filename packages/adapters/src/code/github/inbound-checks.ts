import { z } from "zod";
import {
  branchBindings,
  isOrchestratorBranch,
  malformedWebhook,
  NOT_ORCHESTRATOR_BRANCH,
  type GithubContext,
} from "./inbound-shared";
import type { CodeInbound } from "../types";

/** Checks GitHub ran on a commit no pull request of this repository holds. */
const NO_PULL_REQUEST: CodeInbound = { ignore: "check without a pull request" };

const checkPullRequestsSchema = z.array(z.object({ number: z.number() }));

const checkSuiteWebhookSchema = z.object({
  action: z.string(),
  check_suite: z.object({
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable(),
    pull_requests: checkPullRequestsSchema,
    app: z.object({ name: z.string().optional() }).nullish(),
  }),
});

const checkRunWebhookSchema = z.object({
  action: z.string(),
  check_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    check_suite: z.object({ head_branch: z.string().nullish() }).nullish(),
    pull_requests: checkPullRequestsSchema,
    html_url: z.string().nullish(),
    output: z.object({ title: z.string().nullish(), summary: z.string().nullish() }).nullish(),
  }),
});

/**
 * A completed check suite on a pull request of an orchestrator branch becomes `ci_event` with its
 * conclusion.
 */
export async function githubCheckSuiteEvent(context: GithubContext): Promise<CodeInbound> {
  const parsed = checkSuiteWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("check_suite");
  const { action, check_suite: suite } = parsed.data;
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
  const parsed = checkRunWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("check_run");
  const { action, check_run: run } = parsed.data;
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
