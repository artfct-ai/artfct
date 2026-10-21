/** The prefix of the events that report on their pull request: `github.pull_request.<action>`. */
const PULL_REQUEST_EVENT_PREFIX = "github.pull_request.";

/** The `action` of a GitHub webhook payload. Null when the payload does not carry one. */
function actionOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("action" in payload)) return null;
  return typeof payload.action === "string" ? payload.action : null;
}

/**
 * The vendor event name of a GitHub delivery, from its `X-GitHub-Event` header and its payload:
 * `github.<event>.<action>`, or `github.<event>` when the payload does not carry an action.
 */
export function githubVendorEventName(githubEvent: string, payload: unknown): string {
  const action = actionOf(payload);
  return action === null ? `github.${githubEvent}` : `github.${githubEvent}.${action}`;
}

/** True for a pull request event, which reports on its pull request and watches it. */
export function isGithubPullRequestEventName(name: string): boolean {
  return name.startsWith(PULL_REQUEST_EVENT_PREFIX);
}
