import { githubCheckRunEvent, githubCheckSuiteEvent } from "./inbound-checks";
import { githubPullRequestEvent } from "./inbound-pull-request";
import { githubPushEvent } from "./inbound-push";
import {
  githubIssueCommentEvent,
  githubReviewCommentEvent,
  githubReviewEvent,
} from "./inbound-review";
import type { GithubContext, GithubRepo } from "./inbound-shared";
import type { CodeInbound, CodeInboundContext } from "../types";

/** Map a GitHub App webhook to an inbound event. The bindings on the event resolve the workflow. */
export async function githubInbound(
  eventName: string,
  payload: Record<string, unknown>,
  context: CodeInboundContext,
): Promise<CodeInbound> {
  const repo = payload.repository as GithubRepo | undefined;
  if (!repo) return { ignore: "no repository" };

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
      return { ignore: eventName };
  }
}
