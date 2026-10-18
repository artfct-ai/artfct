/// A tracker session whose workflow opens a pull request, and the code host events on it.
module sessionWithPullRequest {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(SessionASurface, PullSurface), MAX_DELIVERIES = 2).* from "./routerBindings"
}
