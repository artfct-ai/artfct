/// Two findings reviewers in one segment, then a polisher, for a model-call author.
module modelCallAuthorWithTwoReviewers {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = true).* from "./reviewLoop"
}
