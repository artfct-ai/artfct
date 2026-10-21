/** The prefix of every GitHub vendor event name. */
const GITHUB_EVENT_PREFIX = "github.";

/** The prefix of the events that report on their pull request: `github.pull_request.<action>`. */
const PULL_REQUEST_EVENT_PREFIX = `${GITHUB_EVENT_PREFIX}pull_request.`;

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
  const name = `${GITHUB_EVENT_PREFIX}${githubEvent}`;
  return action === null ? name : `${name}.${action}`;
}

/**
 * The `X-GitHub-Event` header of the deliveries a vendor event name matches, such as
 * `pull_request` for `github.pull_request.opened`. Null for another vendor's event name.
 */
export function githubEventOfVendorEventName(name: string): string | null {
  if (!name.startsWith(GITHUB_EVENT_PREFIX)) return null;
  const [githubEvent = ""] = name.slice(GITHUB_EVENT_PREFIX.length).split(".");
  return githubEvent;
}

/** True for a pull request event, which reports on its pull request and watches it. */
export function isGithubPullRequestEventName(name: string): boolean {
  return name.startsWith(PULL_REQUEST_EVENT_PREFIX);
}
