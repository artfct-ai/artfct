/// Messages in one chat thread.
module chatThread {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(ThreadSurface), MAX_DELIVERIES = 2).* from "./routerBindings"
}
