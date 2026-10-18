/// A workflow that starts from a tracker session on its subject issue, model checked with a pause.
module trackerPause {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = false, RESEARCH = false, MODEL_AUTHOR = false).* from "./sessionRouting"
}
