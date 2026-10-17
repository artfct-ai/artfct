/// The author of each job writes its page with model calls, and the humans get the page as the
/// author leaves it.
module pagesFromModelCalls {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(REFINER = false, MODEL_AUTHOR = true, RESEARCH = false).* from "./workflowLifecycle"
}
