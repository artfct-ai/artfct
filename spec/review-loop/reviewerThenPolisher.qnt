/// A findings reviewer, then a polisher, for a harness author of a pull request.
module reviewerThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = false, ARTIFACT = PullRequest).* from "./reviewLoop"
}
