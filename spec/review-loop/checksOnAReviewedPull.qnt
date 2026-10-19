/// A findings reviewer, then a polisher, for a harness author of a pull request whose pushes the
/// checks gate holds. The author does not end, so traces reach a second revision.
module checksOnAReviewedPull {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = false, ARTIFACT = PullRequest, INSTANCE_RESTARTS = true, UNREADABLE_REVISIONS = true, AUTHOR_LIFECYCLE = false, PAUSE_AND_RESUME = false, CHECKS = true).* from "./reviewLoop"
}
