/// A workflow that starts from a tracker session, where the author of each job is a model call.
module trackerModelCall {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = false, RESEARCH = false, MODEL_AUTHOR = true).* from "./sessionRouting"
}
