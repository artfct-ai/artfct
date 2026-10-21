/// A chat thread whose workflows may start a job on an issue, and tracker sessions on that issue.
module issueAndThread {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(ThreadSurface, SessionSurface), MAX_DELIVERIES = 2, PULLS = Set()).* from "./routerBindings"
}
