/// A judge, then a polisher, for a model-call author of a page whose workflow instance restarts.
module modelCallJudgeThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [Judge, Polisher], MODEL_CALL_AUTHOR = true, ARTIFACT = Page, INSTANCE_RESTARTS = true, UNREADABLE_REVISIONS = false, AUTHOR_LIFECYCLE = false, PAUSE_AND_RESUME = false, CHECKS = false).* from "./reviewLoop"
}
