/// Two findings reviewers in one segment, then a polisher, for a model-call author of a page.
module modelCallAuthorWithTwoReviewers {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, FindingsReviewer, Polisher], MODEL_CALL_AUTHOR = true, ARTIFACT = Page, INSTANCE_RESTARTS = false, UNREADABLE_REVISIONS = false, AUTHOR_LIFECYCLE = false).* from "./reviewLoop"
}
