/**
 * The code host capability: pull requests, checks, reviews, repositories, and credentials for
 * sandboxes. Consumers program against `CodeHost`. GitHub implements it today.
 */
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { CodeUser } from "@artfct-ai/contracts/types";

/** Resolves a code host login to a person the orchestrator trusts, or to null. */
export type CodeActorResolver = (user: CodeUser) => Promise<Actor | null>;

/** A normalized event ready to deliver, or the reason the webhook is ignored. */
export type CodeInbound = { event: InboundEvent } | { ignore: string };

/** What a code host webhook mapper needs besides the payload. */
export type CodeInboundContext = {
  resolveActor: CodeActorResolver;
  /** The host's id for this delivery. It makes the event id unique. */
  deliveryId: string;
  /** Logins the orchestrator itself acts under. Its own reviews and comments are never events. */
  ownLogins: string[];
};

/** The subset of a pull request the orchestrator reads. */
export type PullRequest = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  /** True when the head branch lives in another repository. */
  from_fork: boolean;
  title: string;
};

/** One check run on a commit. */
export type CheckRun = { name: string; conclusion: string | null; html_url: string };

/** One check on a commit that did not pass. `detail` is what the check said about it. */
export type CheckFailure = { name: string; conclusion: string; detail: string; url: string | null };

/**
 * What every check on one commit says together. `failed` holds failures a code change may
 * fix. `stopped` holds the ones it cannot fix, such as a cancelled run.
 */
export type CommitChecks =
  | { state: "unreported" }
  | { state: "running" }
  | { state: "passed"; settled_at: string }
  | { state: "failed"; failures: CheckFailure[] }
  | { state: "stopped"; failures: CheckFailure[] };

/**
 * Permission levels for a scoped token, keyed by the host's permission names (`contents`,
 * `pull_requests`, `metadata`). Must be a subset of what the credential was granted.
 */
export type Permissions = Record<string, "read" | "write">;

/** A token and the instant it stops working, in ms since the epoch. */
export type MintedToken = { token: string; expiresAt: number };

/** The name and email git records on a commit. */
export type CommitAuthor = { name: string; email: string };

/** A submitted review on a pull request. `state` is the host's uppercase review state. */
export type PullRequestReview = {
  id: number;
  user: { login: string; type?: string } | null;
  state: string;
  body: string | null;
  commit_id: string | null;
  submitted_at: string | null;
};

/** One inline comment that belongs to a review. `id` is what a reaction is addressed to. */
export type PullRequestReviewComment = {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
};

/** A comment a reaction can land on: a conversation comment or an inline review comment. */
export type CommentRef = { kind: "issue" | "review"; id: number };

/** The reactions GitHub accepts on a comment. */
export type Reaction = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

/** How one code host's reviews are written and read back. */
export type CodeReview = {
  /** What a reviewer sandbox may do. Narrows the token the reviewer run gets. */
  permissions: Permissions;
  /** How the reviewer files its review, one step per tool call. */
  reportSteps: string[];
  /** What the reviewer must write for its review to be readable. */
  reportRules: string;
  /** True when a submitted review blocks, from the host's review state and the body. */
  blocking(state: string, body: string): boolean;
};

/** What the orchestrator asks of a code host. `repo` is always `owner/name`. */
export interface CodeHost {
  /**
   * Whether the login may push to the repository. The host counts every grant: the login's
   * own, a team's, and the organization's.
   */
  canPush(repo: string, login: string): Promise<boolean>;
  getPull(repo: string, number: number): Promise<PullRequest>;
  /** Open pull requests whose head is the given branch. */
  pullsForBranch(repo: string, branch: string): Promise<PullRequest[]>;
  checkRunsForRef(repo: string, ref: string): Promise<CheckRun[]>;
  /** What every check on one commit says together, whichever system reported it. */
  commitChecks(repo: string, sha: string): Promise<CommitChecks>;
  /** Every submitted review on a pull request, oldest first. */
  pullReviews(repo: string, number: number): Promise<PullRequestReview[]>;
  /** Every inline comment that belongs to one review. */
  reviewComments(
    repo: string,
    number: number,
    reviewId: number,
  ): Promise<PullRequestReviewComment[]>;
  commentOnPull(repo: string, number: number, body: string): Promise<{ id: number }>;
  /** Leave one reaction on a comment. */
  reactToComment(repo: string, comment: CommentRef, reaction: Reaction): Promise<void>;
  /** Full names of the repositories these credentials can reach. */
  repositories(): Promise<string[]>;
  /**
   * A token minted now, never from a cache, with the instant it stops working. It reaches the
   * one repository, with `permissions` alone when they are given.
   */
  mintToken(repo: string, permissions?: Permissions): Promise<MintedToken>;
  /** Login that this credential's own reviews and comments are authored by. */
  reviewerLogin(): Promise<string>;
  /** The author a sandbox commits as, so the host links each commit to this credential's account. */
  commitAuthor(): Promise<CommitAuthor>;
}
