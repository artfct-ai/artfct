/// The stage asks for an effort the harness session does not hold, so the effort is set before the
/// first prompt.
module stageAsksForEffort {
  import harnessSessionTypes.* from "./harnessSession"
  import harnessSession(ASKS_EFFORT = true, PAUSES_RUNNING_TURNS = false, INTERRUPTS_AFTER_THE_FIRST_PROMPT = false, BINDS_A_BRANCH = false).* from "./harnessSession"
}
