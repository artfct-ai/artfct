/// A polisher alone, for a model-call author of a page that a person or the agent pauses, resumes,
/// and instructs.
module pausedModelCallAuthor {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [Polisher], MODEL_CALL_AUTHOR = true, ARTIFACT = Page, INSTANCE_RESTARTS = false, UNREADABLE_REVISIONS = true, AUTHOR_LIFECYCLE = false, PAUSE_AND_RESUME = true, CHECKS = false).* from "./reviewLoop"
}
