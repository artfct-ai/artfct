/// A workflow that starts from a tracker session, where a researcher runs before the harness
/// author of each job.
module trackerResearch {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = false, RESEARCH = true, MODEL_AUTHOR = false).* from "./sessionRouting"
}
