/// The agent pauses and resumes the author during its turns, so a resume lands during a cancelled
/// turn.
module agentPausesRunningTurns {
  import harnessSessionTypes.* from "./harnessSession"
  import harnessSession(ASKS_EFFORT = false, PAUSES_RUNNING_TURNS = true, INTERRUPTS_AFTER_THE_FIRST_PROMPT = false).* from "./harnessSession"
}
