import { z } from "zod";
import type { PullDetail } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { CodeUser } from "@artfct-ai/contracts/types";
import { ORCHESTRATOR_BRANCH_PREFIX } from "../branch-prefix";
import type { CodeInbound, CodeInboundContext } from "../types";

/** Repository fields GitHub sends on every webhook. */
export const githubRepoSchema = z.object({
  full_name: z.string(),
  default_branch: z.string().nullish(),
});

/** A GitHub user reference. `type` is `Bot` when the author is an App rather than a person. */
export const githubUserSchema = z.object({ login: z.string(), type: z.string().nullish() });

/** Pull request fields the mappers read. `head.repo` is null when a fork was deleted. */
export const githubPullRequestSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  merged: z.boolean().nullish(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullish() }),
  base: z.object({ ref: z.string() }),
  title: z.string().nullish(),
  user: z.object({ login: z.string() }).nullish(),
});

/** A repository as the webhook names it. */
export type GithubRepo = z.infer<typeof githubRepoSchema>;

/** A pull request as the webhook carries it. */
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>;

/** A user as the webhook names them. */
export type GithubUser = z.infer<typeof githubUserSchema>;

/** True when the user is an App, by account type or by the `[bot]` login suffix. */
export function isGithubApp(user: GithubUser): boolean {
  return user.type === "Bot" || user.login.endsWith("[bot]");
}

/** One GitHub webhook with the repository split out, ready for a per-event mapper to parse. */
export type GithubContext = CodeInboundContext & {
  eventId: string;
  repo: GithubRepo;
  payload: unknown;
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

/** The ignore for a webhook that lacks a field its mapper reads, or holds one of another type. */
export function malformedWebhook(eventName: string): CodeInbound {
  return { ignore: `malformed ${eventName}` };
}
