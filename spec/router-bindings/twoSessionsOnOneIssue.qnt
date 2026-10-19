/// Two tracker sessions on one issue, and a chat thread whose workflow may start a job on that issue.
/// Three deliveries can run at once.
module twoSessionsOnOneIssue {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(SessionASurface, SessionBSurface, ThreadSurface), MAX_DELIVERIES = 3, PULLS = Set()).* from "./routerBindings"
}
