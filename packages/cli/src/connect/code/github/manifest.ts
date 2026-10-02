/** The webhook events ingress maps into inbound events. */
const GITHUB_APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "check_run",
  "push",
];

/** What the app may do: push branches, open and review pull requests, comment, and read CI. */
const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
};

/** Where GitHub sends the app's webhooks and the browser after each step of the setup. */
export type GithubAppManifestUrls = {
  ingressUrl: string;
  redirectUrl: string;
  setupUrl: string;
};

/** The manifest that creates a private GitHub App wired to the deployment's ingress. */
export function githubAppManifest(name: string, urls: GithubAppManifestUrls) {
  return {
    name,
    url: urls.ingressUrl,
    description: "The artfct orchestrator's agent.",
    public: false,
    hook_attributes: { url: new URL("/webhooks/github", urls.ingressUrl).href, active: true },
    redirect_url: urls.redirectUrl,
    setup_url: urls.setupUrl,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: GITHUB_APP_EVENTS,
  };
}
