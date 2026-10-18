/// A workflow that starts from a tracker session on its subject issue. A chat thread may join later.
module trackerOnly {
  import sessionRoutingTypes.* from "./sessionRouting"
  import sessionRouting(STARTS_IN_CHAT = false).* from "./sessionRouting"
}
