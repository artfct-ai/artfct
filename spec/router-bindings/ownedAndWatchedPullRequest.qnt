/// A chat thread whose workflow opens a pull request, a workflow definition whose trigger fires
/// on that pull request, and the pull request's events.
module ownedAndWatchedPullRequest {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(ThreadSurface, PullSurface), MAX_DELIVERIES = 2, PULLS = Set(Pull), DEFINITIONS = Set(0), PULL_EVENT_KINDS = Set(Reply)).* from "./routerBindings"
}
