/// The author of each job writes its page with model calls, and a reviewer reads each revision
/// before the humans get it.
module modelCallPagesWithAReviewer {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAChatRequest, REFINER = AReviewer, MODEL_AUTHOR = true, RESEARCH = false, SLOT_COUNTS = Set(2), STAGE_ENDING = AcceptanceEnding).* from "./workflowLifecycle"
}
