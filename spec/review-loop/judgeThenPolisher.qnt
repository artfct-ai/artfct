/// A judge, then a polisher, for a harness author of a pull request.
module judgeThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [Judge, Polisher], MODEL_CALL_AUTHOR = false, ARTIFACT = PullRequest, INSTANCE_RESTARTS = true, UNREADABLE_REVISIONS = true, AUTHOR_LIFECYCLE = true, PAUSE_AND_RESUME = false).* from "./reviewLoop"
}
