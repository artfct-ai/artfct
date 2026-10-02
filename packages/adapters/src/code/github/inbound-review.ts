import {
  githubCodeUser,
  isGithubApp,
  pullRequestBindings,
  pullRequestDetail,
  pullRequestRejection,
  payloadString,
  type GithubContext,
  type GithubPullRequest,
  type GithubUser,
} from "./inbound-shared";
import type { CodeInbound } from "../types";

type Authored = { user: GithubUser };

type Review = Authored & { id: number; state: string; body: string | null };

type ReviewComment = Authored & {
  id: number;
  body: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  pull_request_review_id?: number;
};

type IssueComment = Authored & { id: number; body: string };

type Issue = { number: number; pull_request?: unknown; html_url: string };

const REVIEW_STATES = ["approved", "changes_requested", "commented"];

const AUTHOR_UNAUTHORIZED: CodeInbound = { ignore: "author is not authorized" };

/**
 * A submitted review, whatever its state. The review id goes along, because the inline
 * comments the review carries are not in this payload.
 */
export async function githubReviewEvent(context: GithubContext): Promise<CodeInbound> {
  const pr = context.payload.pull_request as GithubPullRequest;
  const review = context.payload.review as Review;
  const rejected = pullRequestRejection(context.repo, pr);
  if (rejected) return rejected;
  const action = payloadString(context.payload, "action");
  if (action !== "submitted") {
    return { ignore: `review ${action}` };
  }
  if (isOurs(review.user.login, pr, context.ownLogins)) return { ignore: "self review" };
  const state = review.state.toLowerCase();
  if (!REVIEW_STATES.includes(state)) return { ignore: `review ${state}` };
  const actor = await context.resolveActor(githubCodeUser(context, review.user));
  if (!actor) return AUTHOR_UNAUTHORIZED;

  return {
    event: {
      id: context.eventId,
      kind: "feedback",
      actor,
      bindings: pullRequestBindings(context.repo, pr),
      links: [],
      text: review.body ?? "",
      pull: pullRequestDetail(context.repo, pr, "review", {
        reviewer: review.user.login,
        reviewer_is_app: isGithubApp(review.user),
        review_id: review.id,
      }),
    },
  };
}

/** An inline review comment is feedback on that line. Same reviewers as a review. */
export async function githubReviewCommentEvent(context: GithubContext): Promise<CodeInbound> {
  const pr = context.payload.pull_request as GithubPullRequest;
  const comment = context.payload.comment as ReviewComment;
  const rejected = pullRequestRejection(context.repo, pr);
  if (rejected) return rejected;
  const action = payloadString(context.payload, "action");
  if (action !== "created") {
    return { ignore: `review comment ${action}` };
  }
  if (isOurs(comment.user.login, pr, context.ownLogins)) return { ignore: "self review" };
  const actor = await context.resolveActor(githubCodeUser(context, comment.user));
  if (!actor) return AUTHOR_UNAUTHORIZED;

  return {
    event: {
      id: context.eventId,
      kind: "feedback",
      actor,
      bindings: pullRequestBindings(context.repo, pr),
      links: [],
      text: "",
      pull: pullRequestDetail(context.repo, pr, "review_comment", {
        reviewer: comment.user.login,
        reviewer_is_app: isGithubApp(comment.user),
        review_id: comment.pull_request_review_id,
        comments: [
          {
            id: comment.id,
            path: comment.path,
            line: comment.line ?? comment.original_line ?? undefined,
            body: comment.body,
          },
        ],
      }),
    },
  };
}

/** A conversation comment on a PR from a human is feedback too. Machines are out. */
export async function githubIssueCommentEvent(context: GithubContext): Promise<CodeInbound> {
  const issue = context.payload.issue as Issue;
  const comment = context.payload.comment as IssueComment;
  if (!issue.pull_request) return { ignore: "issue comment, not a PR" };
  const action = payloadString(context.payload, "action");
  if (action !== "created") {
    return { ignore: `issue comment ${action}` };
  }
  if (isGithubApp(comment.user) || context.ownLogins.includes(comment.user.login)) {
    return { ignore: "bot comment" };
  }
  const actor = await context.resolveActor(githubCodeUser(context, comment.user));
  if (!actor) return AUTHOR_UNAUTHORIZED;

  return {
    event: {
      id: context.eventId,
      kind: "feedback",
      actor,
      bindings: [{ source: "code_pull", repo: context.repo.full_name, number: issue.number }],
      links: [],
      text: comment.body,
      pull: {
        action: "comment",
        repo: context.repo.full_name,
        number: issue.number,
        reviewer: comment.user.login,
        comment_id: comment.id,
      },
    },
  };
}

/** True when a review is the orchestrator's own coming back: by its login or by authoring the PR. */
function isOurs(login: string, pr: GithubPullRequest, ownLogins: string[]): boolean {
  return ownLogins.includes(login) || (pr.user?.login !== undefined && login === pr.user.login);
}
