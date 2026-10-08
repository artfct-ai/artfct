import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { workerdFetch } from "../../workerd-fetch";
import { githubCommitChecks } from "./commit-checks";
import { toCheckRun, toPullRequest, toReview, toReviewComment } from "./mapping";
import { normalizePrivateKeyPem } from "./private-key";
import type {
  CheckRun,
  CodeHost,
  CommentRef,
  CommitAuthor,
  CommitChecks,
  MintedToken,
  Permissions,
  PullRequest,
  PullRequestReview,
  PullRequestReviewComment,
  Reaction,
} from "../types";

const DEFAULT_BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** The auth-app instance. Not exported by name from `@octokit/auth-app`. */
type AppAuth = ReturnType<typeof createAppAuth>;

/** GitHub App credentials. The private key is the PEM GitHub downloads, PKCS#1 or PKCS#8. */
export type GithubAppAuth = { appId: string; privateKeyPem: string; installationId: string };

/** Construction options. `fetch` is a seam for tests. */
export type GithubOptions = { baseUrl?: string; fetch?: typeof fetch };

/** Every request times out, so no call hangs inside a Durable Object. */
function withTimeout(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

/** `owner/name` split in two. */
function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`github: repo must be owner/name, got "${fullName}"`);
  }
  return { owner, repo };
}

/** The base roles that may push. GitHub reports the maintain role as `write`. */
const PUSH_PERMISSIONS = ["admin", "write"];

/** What a read token may do: read the code and the repository itself. */
const READ_PERMISSIONS: Permissions = { contents: "read", metadata: "read" };

/** The auth-app instance behind an Octokit built with `authStrategy: createAppAuth`. */
function appAuthOf(octokit: Octokit): AppAuth {
  return octokit.auth as AppAuth;
}

/** The GitHub code host over the official Octokit SDKs. Authenticates as an App installation. */
export class GithubCodeHost implements CodeHost {
  private readonly octokit: Octokit;
  private readonly appAuth: AppAuth;
  private cachedReviewerLogin: string | null = null;
  private cachedCommitAuthor: CommitAuthor | null = null;

  constructor(auth: GithubAppAuth, options: GithubOptions = {}) {
    this.octokit = new Octokit({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      userAgent: "artfct",
      request: { fetch: withTimeout(workerdFetch(options.fetch)) },
      authStrategy: createAppAuth,
      auth: {
        appId: auth.appId,
        privateKey: normalizePrivateKeyPem(auth.privateKeyPem),
        installationId: auth.installationId,
      },
    });
    this.appAuth = appAuthOf(this.octokit);
  }

  async canPush(fullName: string, login: string): Promise<boolean> {
    const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
      ...splitRepo(fullName),
      username: login,
    });
    return PUSH_PERMISSIONS.includes(data.permission);
  }

  async getPull(fullName: string, number: number): Promise<PullRequest> {
    const { data } = await this.octokit.rest.pulls.get({
      ...splitRepo(fullName),
      pull_number: number,
    });
    return toPullRequest(data);
  }

  async pullsForBranch(fullName: string, branch: string): Promise<PullRequest[]> {
    const { owner, repo } = splitRepo(fullName);
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`,
    });
    return data.map(toPullRequest);
  }

  async checkRunsForRef(fullName: string, ref: string): Promise<CheckRun[]> {
    const { data } = await this.octokit.rest.checks.listForRef({
      ...splitRepo(fullName),
      ref,
      per_page: PAGE_SIZE,
    });
    return data.check_runs.map(toCheckRun);
  }

  /** Check runs, their suites, and commit statuses together cover every system that reports. */
  async commitChecks(fullName: string, sha: string): Promise<CommitChecks> {
    const commit = { ...splitRepo(fullName), ref: sha, per_page: PAGE_SIZE };
    const { checks, repos } = this.octokit.rest;
    const [runs, suites, combined] = await Promise.all([
      collectPages(this.octokit.paginate.iterator(checks.listForRef, commit)),
      collectPages(this.octokit.paginate.iterator(checks.listSuitesForRef, commit)),
      repos.getCombinedStatusForRef(commit),
    ]);
    return githubCommitChecks({ runs, suites, statuses: combined.data.statuses });
  }

  async pullReviews(fullName: string, number: number): Promise<PullRequestReview[]> {
    const pages = this.octokit.paginate.iterator(this.octokit.rest.pulls.listReviews, {
      ...splitRepo(fullName),
      pull_number: number,
      per_page: PAGE_SIZE,
    });
    return (await collectPages(pages)).map(toReview);
  }

  async reviewComments(
    fullName: string,
    number: number,
    reviewId: number,
  ): Promise<PullRequestReviewComment[]> {
    const pages = this.octokit.paginate.iterator(this.octokit.rest.pulls.listCommentsForReview, {
      ...splitRepo(fullName),
      pull_number: number,
      review_id: reviewId,
      per_page: PAGE_SIZE,
    });
    return (await collectPages(pages)).map(toReviewComment);
  }

  async commentOnPull(fullName: string, number: number, body: string): Promise<{ id: number }> {
    const { data } = await this.octokit.rest.issues.createComment({
      ...splitRepo(fullName),
      issue_number: number,
      body,
    });
    return { id: data.id };
  }

  async reactToComment(fullName: string, comment: CommentRef, reaction: Reaction): Promise<void> {
    const request = { ...splitRepo(fullName), comment_id: comment.id, content: reaction };
    switch (comment.kind) {
      case "issue":
        await this.octokit.rest.reactions.createForIssueComment(request);
        return;
      case "review":
        await this.octokit.rest.reactions.createForPullRequestReviewComment(request);
        return;
      default: {
        const unhandled: never = comment.kind;
        throw new Error(`github: unhandled comment kind ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** The repositories of the installation. First page only. */
  async repositories(): Promise<string[]> {
    const { data } = await this.octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: PAGE_SIZE,
    });
    return data.repositories.map((repository) => repository.full_name);
  }

  /** Never from auth-app's cache, so the whole lifetime is left on the token. */
  async mintToken(repo: string, permissions?: Permissions): Promise<MintedToken> {
    const minted = await this.appAuth({
      type: "installation",
      repositoryNames: [splitRepo(repo).repo],
      permissions,
      refresh: true,
    });
    return { token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
  }

  /** Without a repository list, the token reaches every repository of the installation. */
  async mintReadToken(): Promise<MintedToken> {
    const minted = await this.appAuth({
      type: "installation",
      permissions: READ_PERMISSIONS,
      refresh: true,
    });
    return { token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
  }

  /** The App acts as `<slug>[bot]`. Cached. */
  async reviewerLogin(): Promise<string> {
    this.cachedReviewerLogin ??= await this.lookupReviewerLogin();
    return this.cachedReviewerLogin;
  }

  private async lookupReviewerLogin(): Promise<string> {
    const { data } = await this.octokit.rest.apps.getAuthenticated();
    if (!data?.slug) throw new Error("github: the App has no slug");
    return `${data.slug}[bot]`;
  }

  /** GitHub's noreply address for the account, which links the commit to it. Cached. */
  async commitAuthor(): Promise<CommitAuthor> {
    this.cachedCommitAuthor ??= await this.lookupCommitAuthor();
    return this.cachedCommitAuthor;
  }

  private async lookupCommitAuthor(): Promise<CommitAuthor> {
    const login = await this.reviewerLogin();
    const { data } = await this.octokit.rest.users.getByUsername({ username: login });
    return { name: login, email: `${data.id}+${login}@users.noreply.github.com` };
  }
}

/** Drain a paged list, up to `MAX_PAGES` pages. */
async function collectPages<Row>(pages: AsyncIterable<{ data: Row[] }>): Promise<Row[]> {
  const rows: Row[] = [];
  let pageCount = 0;
  for await (const page of pages) {
    rows.push(...page.data);
    pageCount += 1;
    if (pageCount >= MAX_PAGES) break;
  }
  return rows;
}
