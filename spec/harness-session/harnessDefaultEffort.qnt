/// The stage leaves the effort to the harness, so the first prompt follows `session/new`.
module harnessDefaultEffort {
  import harnessSessionTypes.* from "./harnessSession"
  import harnessSession(ASKS_EFFORT = false, PAUSES_RUNNING_TURNS = false, INTERRUPTS_AFTER_THE_FIRST_PROMPT = false, BINDS_A_BRANCH = false).* from "./harnessSession"
}
