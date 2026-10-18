/// A workflow that starts from a chat thread. The tracker may open sessions on its issues.
module chatThread {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = true, RESEARCH = false, MODEL_AUTHOR = false).* from "./sessionRouting"
}
