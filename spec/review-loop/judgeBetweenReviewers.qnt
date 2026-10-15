/// A findings reviewer, a judge, and a second findings reviewer, for a harness author.
module judgeBetweenReviewers {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Judge, FindingsReviewer], MODEL_CALL_AUTHOR = false).* from "./reviewLoop"
}
