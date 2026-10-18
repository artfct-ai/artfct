/// Each job writes a page that a polisher changes before the humans get it. The polisher closes
/// the author's container as it starts and holds the author's prompts until it ends.
module pagesWithAPolisher {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAChatRequest, REFINER = APolisher, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
