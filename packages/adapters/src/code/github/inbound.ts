import { z } from "zod";
import { githubCheckRunEvent, githubCheckSuiteEvent } from "./inbound-checks";
import { githubPullRequestEvent } from "./inbound-pull-request";
import { githubPushEvent } from "./inbound-push";
import {
  githubIssueCommentEvent,
  githubReviewCommentEvent,
  githubReviewEvent,
} from "./inbound-review";
import { githubRepoSchema, type GithubContext } from "./inbound-shared";
import type { CodeInbound, CodeInboundContext } from "../types";

const repositoryWebhookSchema = z.object({ repository: githubRepoSchema });

/**
 * Map a GitHub App webhook to an inbound event. The bindings on the event resolve the workflow.
 * A payload without the fields its event needs is ignored.
 */
export async function githubInbound(
  eventName: string,
  payload: unknown,
  context: CodeInboundContext,
): Promise<CodeInbound> {
  const parsed = repositoryWebhookSchema.safeParse(payload);
  if (!parsed.success) return { ignore: "no repository" };
  const repo = parsed.data.repository;

  const eventContext: GithubContext = {
    ...context,
    eventId: `github:${context.deliveryId}`,
    repo,
    payload,
  };
  switch (eventName) {
    case "pull_request":
      return githubPullRequestEvent(eventContext);
    case "pull_request_review":
      return githubReviewEvent(eventContext);
    case "pull_request_review_comment":
      return githubReviewCommentEvent(eventContext);
    case "issue_comment":
      return githubIssueCommentEvent(eventContext);
    case "check_suite":
      return githubCheckSuiteEvent(eventContext);
    case "check_run":
      return githubCheckRunEvent(eventContext);
    case "push":
      return githubPushEvent(eventContext);
    default:
      return { ignore: `unhandled github event "${eventName}"` };
  }
}
