/// A workflow that starts from a tracker session on its subject issue, with few jobs, so model
/// checking reaches restarts and repeated deliveries of session messages.
module trackerDelivery {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = false, RESEARCH = false, MODEL_AUTHOR = false).* from "./sessionRouting"
}
