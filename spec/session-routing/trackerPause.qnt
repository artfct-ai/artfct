/// A workflow that starts from a tracker session on its subject issue, model checked with a pause.
/// It has the model of `trackerOnly`, so only TLC checks it, at its own bounds.
module trackerPause {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = false, RESEARCH = false, MODEL_AUTHOR = false).* from "./sessionRouting"
}
