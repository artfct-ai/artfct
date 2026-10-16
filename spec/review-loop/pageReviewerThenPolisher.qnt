/// A findings reviewer, then a polisher, for a harness author of a page.
module pageReviewerThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = false, ARTIFACT = Page).* from "./reviewLoop"
}
