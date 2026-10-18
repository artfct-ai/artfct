/// Each job writes a page that goes to the humans as the author leaves it.
module pagesWithoutRefiners {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
