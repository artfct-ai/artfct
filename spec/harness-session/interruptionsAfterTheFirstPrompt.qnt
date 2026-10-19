/// Nothing interrupts the work before the first prompt goes out, so the samples reach the end of a
/// turn, the outcome check and the agent wake more often.
module interruptionsAfterTheFirstPrompt {
  import harnessSessionTypes.* from "./harnessSession"
  import harnessSession(
    ASKS_EFFORT = false,
    PAUSES_RUNNING_TURNS = false,
    INTERRUPTS_AFTER_THE_FIRST_PROMPT = true,
    BINDS_A_BRANCH = false,
  ).* from "./harnessSession"
}
