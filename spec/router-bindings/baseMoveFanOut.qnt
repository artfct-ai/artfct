/// A chat thread and a tracker session whose workflows each open a pull request in one repository,
/// and pushes to the repository's base branch that fan out to them.
module baseMoveFanOut {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(ThreadSurface, SessionASurface, BaseSurface), MAX_DELIVERIES = 2, PULLS = Set(Pull, SecondPull)).* from "./routerBindings"
}
