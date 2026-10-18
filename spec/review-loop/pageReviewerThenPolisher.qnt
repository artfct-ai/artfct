/// A findings reviewer, then a polisher, for a harness author of a page.
module pageReviewerThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = false, ARTIFACT = Page, INSTANCE_RESTARTS = true, UNREADABLE_REVISIONS = true, AUTHOR_LIFECYCLE = false, PAUSE_AND_RESUME = false, CHECKS = false).* from "./reviewLoop"
}
