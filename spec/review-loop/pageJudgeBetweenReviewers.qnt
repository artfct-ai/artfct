/// A findings reviewer, a judge, and a second findings reviewer, for a harness author of a page.
module pageJudgeBetweenReviewers {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Judge, FindingsReviewer], MODEL_CALL_AUTHOR = false, ARTIFACT = Page, INSTANCE_RESTARTS = true, UNREADABLE_REVISIONS = false, AUTHOR_LIFECYCLE = true, PAUSE_AND_RESUME = false, CHECKS = false).* from "./reviewLoop"
}
