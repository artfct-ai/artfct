/// The stage gives the job its own branch, so the provision alarm writes the branch binding before
/// it starts the sandbox, and a cancel, a stop or a restart may land while that write is out.
module jobOnABranch {
  import harnessSessionTypes.* from "./harnessSession"
  import harnessSession(
    ASKS_EFFORT = false,
    PAUSES_RUNNING_TURNS = false,
    INTERRUPTS_AFTER_THE_FIRST_PROMPT = false,
    BINDS_A_BRANCH = true,
  ).* from "./harnessSession"
}
