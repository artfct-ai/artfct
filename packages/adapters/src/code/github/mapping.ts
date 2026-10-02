/** Pure mappers from GitHub REST payloads to the plain `CodeHost` types. */

import type { CheckRun, PullRequest, PullRequestReview, PullRequestReviewComment } from "../types";

/** The fields read from `GET /pulls/{n}` and from each `GET /pulls` list item. */
export type PullPayload = {
  number: number;
  html_url: string;
  state: string;
  title: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
  merged_at: string | null;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
};

/** One check run as GitHub lists it. */
export type CheckRunPayload = { name: string; conclusion: string | null; html_url: string | null };

/** One review as GitHub lists it. `submitted_at` is absent on a pending review. */
export type ReviewPayload = {
  id: number;
  user: { login: string; type?: string } | null;
  state: string;
  body: string | null;
  commit_id: string | null;
  submitted_at?: string;
};

/** One inline review comment. Lines are absent when the comment is on an outdated diff. */
export type ReviewCommentPayload = {
  id: number;
  path: string;
  line?: number;
  original_line?: number;
  body: string;
};

/**
 * One pull request. The list endpoint omits `merged`, `mergeable` and `mergeable_state`, so
 * merge state comes from `merged_at` and mergeability reads as unknown.
 */
export function toPullRequest(data: PullPayload): PullRequest {
  return {
    number: data.number,
    html_url: data.html_url,
    state: data.state === "closed" ? "closed" : "open",
    merged: data.merged ?? data.merged_at !== null,
    mergeable: data.mergeable ?? null,
    mergeable_state: data.mergeable_state ?? "unknown",
    head: { ref: data.head.ref, sha: data.head.sha },
    base: { ref: data.base.ref },
    from_fork: data.head.repo?.full_name !== data.base.repo.full_name,
    title: data.title,
  };
}

/** A check run. GitHub types `html_url` as nullable, the interface does not. */
export function toCheckRun(data: CheckRunPayload): CheckRun {
  return { name: data.name, conclusion: data.conclusion, html_url: data.html_url ?? "" };
}

/** A submitted review with its author reduced to login and account type. */
export function toReview(data: ReviewPayload): PullRequestReview {
  return {
    id: data.id,
    user: data.user ? { login: data.user.login, type: data.user.type } : null,
    state: data.state,
    body: data.body,
    commit_id: data.commit_id,
    submitted_at: data.submitted_at ?? null,
  };
}

/** An inline review comment with absent line numbers read as null. */
export function toReviewComment(data: ReviewCommentPayload): PullRequestReviewComment {
  return {
    id: data.id,
    path: data.path,
    line: data.line ?? null,
    original_line: data.original_line ?? null,
    body: data.body,
  };
}
