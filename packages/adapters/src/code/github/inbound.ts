import { z } from "zod";
import {
  isGithubConversationalEvent,
  type GithubConversationalEvent,
} from "./conversational-events";
import { githubCheckRunEvent, githubCheckSuiteEvent } from "./inbound-checks";
import { githubPullRequestEvent } from "./inbound-pull-request";
import { githubPushEvent } from "./inbound-push";
import {
  githubIssueCommentEvent,
  githubReviewCommentEvent,
  githubReviewEvent,
} from "./inbound-review";
import { githubRepoSchema, type GithubContext } from "./inbound-shared";
import { githubVendorEventName } from "./vendor-event-name";
import type { CodeInbound, CodeInboundContext } from "../types";

const repositoryWebhookSchema = z.object({ repository: githubRepoSchema });

/** The mapper of each conversational event. Only these names become messages. */
const CONVERSATIONAL_MAPPERS: Record<
  GithubConversationalEvent,
  (context: GithubContext) => Promise<CodeInbound>
> = {
  "github.pull_request_review.submitted": githubReviewEvent,
  "github.pull_request_review_comment.created": githubReviewCommentEvent,
  "github.issue_comment.created": githubIssueCommentEvent,
};

/**
 * Map a GitHub App webhook to an inbound event. The bindings on the event resolve the workflow.
 * Only a conversational event becomes a message. Pull request, check and push events become the
 * events the conversation records. A payload without the fields its event needs is ignored.
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
  const name = githubVendorEventName(eventName, payload);
  if (isGithubConversationalEvent(name)) return CONVERSATIONAL_MAPPERS[name](eventContext);
  switch (eventName) {
    case "pull_request":
      return githubPullRequestEvent(eventContext);
    case "check_suite":
      return githubCheckSuiteEvent(eventContext);
    case "check_run":
      return githubCheckRunEvent(eventContext);
    case "push":
      return githubPushEvent(eventContext);
    default:
      return { ignore: `unhandled github event "${name}"` };
  }
}
