/// A researcher runs before the harness author of each job, and the humans get the page as the
/// author leaves it.
module pagesAfterResearch {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = true, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
