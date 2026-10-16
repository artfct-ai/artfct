/// A findings reviewer, then a polisher, for a harness author.
module reviewerThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = false).* from "./reviewLoop"
}
