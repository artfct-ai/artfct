/// A workflow that started from a tracker session and has a chat thread too.
module chatAndSession {
  import agentTurnsTypes.* from "./agentTurns"
  import agentTurns(SURFACE = ChatAndSession).* from "./agentTurns"
}
