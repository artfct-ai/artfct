/// The stage leaves the effort to the harness, so the first prompt follows `session/new`.
module harnessDefaultEffort {
  import harnessSessionTypes.* from "./harnessSession"
  import harnessSession(ASKS_EFFORT = false).* from "./harnessSession"
}
