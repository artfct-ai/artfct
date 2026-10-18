/// A researcher runs before the author of each job, which writes its page with model calls. The
/// humans get the page as the author leaves it.
module modelCallPagesAfterResearch {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(REFINER = NoRefiner, MODEL_AUTHOR = true, RESEARCH = true, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
