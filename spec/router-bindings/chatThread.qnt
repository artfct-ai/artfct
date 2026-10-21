/// Messages in one chat thread and in one tracker session without an issue.
module chatThread {
  import routerBindingsTypes.* from "./routerBindings"
  import routerBindings(SURFACES = Set(ThreadSurface, LooseSessionSurface), MAX_DELIVERIES = 2, PULLS = Set(), DEFINITIONS = Set(), PULL_EVENT_KINDS = Set(Reply)).* from "./routerBindings"
}
