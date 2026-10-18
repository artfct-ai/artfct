/// A polisher whose pushes the checks gate holds, for a harness author of a pull request.
module checksOnAPolishedPull {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [Polisher], MODEL_CALL_AUTHOR = false, ARTIFACT = PullRequest, INSTANCE_RESTARTS = false, UNREADABLE_REVISIONS = true, AUTHOR_LIFECYCLE = true, PAUSE_AND_RESUME = false, CHECKS = true).* from "./reviewLoop"
}
