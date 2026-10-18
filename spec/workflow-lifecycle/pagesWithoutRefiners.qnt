/// Each job writes a page that goes to the humans as the author leaves it.
module pagesWithoutRefiners {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(REFINER = false, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
