/// Two tracker sessions on one issue, and a chat thread whose workflow may start a job on that issue.
module twoSessionsOnOneIssue {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(SessionASurface, SessionBSurface, ThreadSurface)).* from "./routerBindings"
}
