/**
 * The GitHub vendor events the conversational path delivers to a conversation as messages. They
 * never fire a trigger.
 */
export const githubConversationalEvents = [
  "github.pull_request_review.submitted",
  "github.pull_request_review_comment.created",
  "github.issue_comment.created",
] as const;

/** One GitHub conversational event. */
export type GithubConversationalEvent = (typeof githubConversationalEvents)[number];

/** True when the vendor event name is one of GitHub's conversational events. */
export function isGithubConversationalEvent(name: string): name is GithubConversationalEvent {
  return (githubConversationalEvents as readonly string[]).includes(name);
}
