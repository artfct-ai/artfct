/// A tracker session on an issue whose workflow opens a pull request, and the code host events on it.
module sessionWithPullRequest {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(SessionSurface, PullSurface), MAX_DELIVERIES = 2, PULLS = Set(Pull)).* from "./routerBindings"
}
