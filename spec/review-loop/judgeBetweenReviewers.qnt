/// A findings reviewer, a judge, and a second findings reviewer, for a harness author of a pull request.
module judgeBetweenReviewers {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [FindingsReviewer, Judge, FindingsReviewer], MODEL_CALL_AUTHOR = false, ARTIFACT = PullRequest, INSTANCE_RESTARTS = true, UNREADABLE_REVISIONS = false).* from "./reviewLoop"
}
