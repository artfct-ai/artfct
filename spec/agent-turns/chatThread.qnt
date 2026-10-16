/// A workflow that answers in one chat thread.
module chatThread {
  import agentTurnsTypes.* from "./agentTurns"
  import agentTurns(SURFACE = ChatOnly).* from "./agentTurns"
}
