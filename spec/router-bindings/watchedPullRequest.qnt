/// Two workflow definitions whose triggers fire on one pull request, and the pull request's
/// events, merges and closes. No workflow owns the pull request.
module watchedPullRequest {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(PullSurface), MAX_DELIVERIES = 2, PULLS = Set(), DEFINITIONS = Set(0, 1), PULL_EVENT_KINDS = Set(Reply, Closed)).* from "./routerBindings"
}
