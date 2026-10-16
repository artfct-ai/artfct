/// Messages in one chat thread.
module chatThread {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(ThreadSurface)).* from "./routerBindings"
}
