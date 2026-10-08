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
} from "../src/code/types";
import { CallLog, type RecordedCall } from "./calls";

/** A pull request fixture. Override any field. */
export function pullRequest(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    state: "open",
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "artfct/wf-1-fix", sha: "abc123" },
    base: { ref: "main" },
    from_fork: false,
    title: "Fix login redirect",
    ...patch,
  };
}

const PASSED_LONG_AGO: CommitChecks = { state: "passed", settled_at: new Date(0).toISOString() };

/** Fixed answers for a `FakeCodeHost`. */
export type CodeHostAnswers = {
  /** The logins that may push. Default everyone. */
  pushers?: string[];
  /** Pull requests by number. `getPull` throws for a number not listed. */
  pulls?: PullRequest[];
  /** Check runs by ref. */
  checks?: Record<string, CheckRun[]>;
  /** What the checks say by commit. A commit not listed passed long ago. */
  commitChecks?: Record<string, CommitChecks>;
  /** Reviews by pull number. */
  reviews?: Record<number, PullRequestReview[]>;
  /** Inline comments by review id. */
  reviewComments?: Record<number, PullRequestReviewComment[]>;
  /** Reachable repositories as `owner/name`. */
  repositories?: string[];
  /** What `mintToken` returns. Default a token that expires in an hour from `now`. */
  token?: MintedToken;
  /** What `mintAllReposReadToken` returns. Default a token that expires in an hour from `now`. */
  allReposReadToken?: MintedToken;
  /** The login reviews are authored by. Default `acme-review[bot]`. */
  reviewer?: string;
  /** The author sandboxes commit as. Default `acme-review[bot]` at its noreply address. */
  commitAuthor?: CommitAuthor;
  /** Every call fails. */
  failing?: boolean;
  /** Milliseconds since the epoch, for the default token expiry. */
  now?: () => number;
};

/** Methods a `FakeCodeHost` records. */
export type CodeHostMethod = keyof CodeHost;

/** An in-memory `CodeHost` that answers from `CodeHostAnswers` and records every call. */
export class FakeCodeHost implements CodeHost {
  private readonly log: CallLog<CodeHostMethod>;
  private comments = 0;

  constructor(private readonly answers: CodeHostAnswers = {}) {
    this.log = new CallLog(answers.failing ?? false);
  }

  get calls(): RecordedCall<CodeHostMethod>[] {
    return this.log.calls;
  }

  argsOf(method: CodeHostMethod): unknown[][] {
    return this.log.argsOf(method);
  }

  async canPush(repo: string, login: string): Promise<boolean> {
    this.log.record("canPush", repo, login);
    return this.answers.pushers?.includes(login) ?? true;
  }

  async getPull(repo: string, number: number): Promise<PullRequest> {
    this.log.record("getPull", repo, number);
    const pull = (this.answers.pulls ?? []).find((candidate) => candidate.number === number);
    if (!pull) throw new Error(`github GET /repos/${repo}/pulls/${number}: 404 Not Found`);
    return pull;
  }

  async pullsForBranch(repo: string, branch: string): Promise<PullRequest[]> {
    this.log.record("pullsForBranch", repo, branch);
    return (this.answers.pulls ?? []).filter(
      (pull) => pull.state === "open" && pull.head.ref === branch,
    );
  }

  async checkRunsForRef(repo: string, ref: string): Promise<CheckRun[]> {
    this.log.record("checkRunsForRef", repo, ref);
    return this.answers.checks?.[ref] ?? [];
  }

  async commitChecks(repo: string, sha: string): Promise<CommitChecks> {
    this.log.record("commitChecks", repo, sha);
    return this.answers.commitChecks?.[sha] ?? PASSED_LONG_AGO;
  }

  async pullReviews(repo: string, number: number): Promise<PullRequestReview[]> {
    this.log.record("pullReviews", repo, number);
    return this.answers.reviews?.[number] ?? [];
  }

  async reviewComments(
    repo: string,
    number: number,
    reviewId: number,
  ): Promise<PullRequestReviewComment[]> {
    this.log.record("reviewComments", repo, number, reviewId);
    return this.answers.reviewComments?.[reviewId] ?? [];
  }

  async commentOnPull(repo: string, number: number, body: string): Promise<{ id: number }> {
    this.log.record("commentOnPull", repo, number, body);
    this.comments += 1;
    return { id: this.comments };
  }

  async reactToComment(repo: string, comment: CommentRef, reaction: Reaction): Promise<void> {
    this.log.record("reactToComment", repo, comment, reaction);
  }

  async repositories(): Promise<string[]> {
    this.log.record("repositories");
    return this.answers.repositories ?? [];
  }

  async mintToken(repo: string, permissions?: Permissions): Promise<MintedToken> {
    this.log.record("mintToken", repo, permissions);
    if (this.answers.token) return this.answers.token;
    const now = (this.answers.now ?? Date.now)();
    return { token: "ghs_fake", expiresAt: now + 3_600_000 };
  }

  async mintAllReposReadToken(): Promise<MintedToken> {
    this.log.record("mintAllReposReadToken");
    if (this.answers.allReposReadToken) return this.answers.allReposReadToken;
    const now = (this.answers.now ?? Date.now)();
    return { token: "ghs_read_fake", expiresAt: now + 3_600_000 };
  }

  async reviewerLogin(): Promise<string> {
    this.log.record("reviewerLogin");
    return this.answers.reviewer ?? "acme-review[bot]";
  }

  async commitAuthor(): Promise<CommitAuthor> {
    this.log.record("commitAuthor");
    return (
      this.answers.commitAuthor ?? {
        name: "acme-review[bot]",
        email: "4242+acme-review[bot]@users.noreply.github.com",
      }
    );
  }
}
