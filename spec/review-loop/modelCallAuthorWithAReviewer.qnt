/// A findings reviewer, then a polisher, for a model-call author of a page.
module modelCallAuthorWithAReviewer {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = true, ARTIFACT = Page).* from "./reviewLoop"
}
