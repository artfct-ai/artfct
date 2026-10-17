/// Each job writes a page that a reviewer reads before the humans get it.
module pagesWithAReviewer {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(REFINER = true, MODEL_AUTHOR = false, RESEARCH = false).* from "./workflowLifecycle"
}
