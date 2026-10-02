import type { PullDetail } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { CodeUser } from "@artfct-ai/contracts/types";
import { ORCHESTRATOR_BRANCH_PREFIX } from "../branch-prefix";
import type { CodeInbound, CodeInboundContext } from "../types";

/** Repository fields GitHub sends on every webhook. */
export type GithubRepo = { full_name: string; default_branch?: string };

/** Pull request fields the mappers read. `head.repo` is null when a fork was deleted. */
export type GithubPullRequest = {
  number: number;
  html_url: string;
  merged?: boolean;
  head: { ref: string; repo?: { full_name: string } | null };
  base: { ref: string };
  title?: string;
  user?: { login: string };
};

/** A GitHub user reference. `type` is `Bot` when the author is an App rather than a person. */
export type GithubUser = { login: string; type?: string };

/** True when the user is an App, by account type or by the `[bot]` login suffix. */
export function isGithubApp(user: GithubUser): boolean {
  return user.type === "Bot" || user.login.endsWith("[bot]");
}

/** One GitHub webhook with the repository split out, ready for a per-event mapper. */
export type GithubContext = CodeInboundContext & {
  eventId: string;
  repo: GithubRepo;
  payload: Record<string, unknown>;
};

/** The user as the identity resolver takes them: on this webhook's repository. */
export function githubCodeUser(context: GithubContext, user: GithubUser): CodeUser {
  return { login: user.login, repo: context.repo.full_name, app: isGithubApp(user) };
}

/** Logins to read as the orchestrator's own: the configured slug, bare and as `<slug>[bot]`. None when unset. */
export function ownGithubLogins(appLogin: string | undefined): string[] {
  const slug = appLogin?.trim();
  if (!slug) return [];
  const bare = slug.endsWith("[bot]") ? slug.slice(0, -"[bot]".length) : slug;
  return [bare, `${bare}[bot]`];
}

/** Shared ignore reason for branches the orchestrator did not create. */
export const NOT_ORCHESTRATOR_BRANCH: CodeInbound = { ignore: "not an orchestrator branch" };

/** Shared ignore reason for PRs whose head branch lives in another repository. */
export const FORK_PULL_REQUEST: CodeInbound = { ignore: "pull request from a fork" };

/** True when the branch starts with the orchestrator branch prefix. */
export function isOrchestratorBranch(branch: string): boolean {
  return branch.startsWith(ORCHESTRATOR_BRANCH_PREFIX);
}

/** Why a PR is not one of ours, or null when it is. */
export function pullRequestRejection(repo: GithubRepo, pr: GithubPullRequest): CodeInbound | null {
  if (!isOrchestratorBranch(pr.head.ref)) return NOT_ORCHESTRATOR_BRANCH;
  if (pr.head.repo?.full_name !== repo.full_name) return FORK_PULL_REQUEST;
  return null;
}

/** Bindings for a PR: its number and its head branch. */
export function pullRequestBindings(repo: GithubRepo, pr: GithubPullRequest): Binding[] {
  return [
    { source: "code_pull", repo: repo.full_name, number: pr.number },
    { source: "code_branch", repo: repo.full_name, branch: pr.head.ref },
  ];
}

/** Bindings for a PR and its branch. The PR binding comes first. */
export function branchBindings(repo: GithubRepo, branch: string, prNumber: number): Binding[] {
  return [
    { source: "code_pull", repo: repo.full_name, number: prNumber },
    { source: "code_branch", repo: repo.full_name, branch },
  ];
}

/** PR detail shared by pull_request and review events. */
export function pullRequestDetail(
  repo: GithubRepo,
  pr: GithubPullRequest,
  action: PullDetail["action"],
  extra: Partial<PullDetail> = {},
): PullDetail {
  return {
    repo: repo.full_name,
    number: pr.number,
    action,
    branch: pr.head.ref,
    base: pr.base.ref,
    ...extra,
  };
}

/** A string field of the payload. Empty when the field is absent or not a string. */
export function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}
