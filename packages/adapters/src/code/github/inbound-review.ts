import { z } from "zod";
import {
  githubCodeUser,
  githubPullRequestSchema,
  githubUserSchema,
  isGithubApp,
  malformedWebhook,
  pullRequestBindings,
  pullRequestDetail,
  pullRequestRejection,
  type GithubContext,
  type GithubPullRequest,
} from "./inbound-shared";
import type { CodeInbound } from "../types";

const reviewWebhookSchema = z.object({
  action: z.string(),
  pull_request: githubPullRequestSchema,
  review: z.object({
    id: z.number(),
    state: z.string(),
    body: z.string().nullish(),
    user: githubUserSchema,
  }),
});

const reviewCommentWebhookSchema = z.object({
  action: z.string(),
  pull_request: githubPullRequestSchema,
  comment: z.object({
    id: z.number(),
    body: z.string(),
    path: z.string().optional(),
    line: z.number().nullish(),
    original_line: z.number().nullish(),
    pull_request_review_id: z.number().nullish(),
    user: githubUserSchema,
  }),
});

const issueCommentWebhookSchema = z.object({
  action: z.string(),
  issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }),
  comment: z.object({ id: z.number(), body: z.string(), user: githubUserSchema }),
});

const REVIEW_STATES = ["approved", "changes_requested", "commented"];

const AUTHOR_UNAUTHORIZED: CodeInbound = { ignore: "author is not authorized" };

/**
 * A submitted review, whatever its state. The review id goes along, because the inline
 * comments the review carries are not in this payload.
 */
export async function githubReviewEvent(context: GithubContext): Promise<CodeInbound> {
  const parsed = reviewWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("pull_request_review");
  const { action, pull_request: pr, review } = parsed.data;
  const rejected = pullRequestRejection(context.repo, pr);
  if (rejected) return rejected;
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
  const parsed = reviewCommentWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("pull_request_review_comment");
  const { action, pull_request: pr, comment } = parsed.data;
  const rejected = pullRequestRejection(context.repo, pr);
  if (rejected) return rejected;
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
        review_id: comment.pull_request_review_id ?? undefined,
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
  const parsed = issueCommentWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("issue_comment");
  const { action, issue, comment } = parsed.data;
  if (!issue.pull_request) return { ignore: "issue comment, not a PR" };
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
