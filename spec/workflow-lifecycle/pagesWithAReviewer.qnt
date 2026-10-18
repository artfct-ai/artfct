/// Each job writes a page that a reviewer reads before the humans get it. A judge runs the same
/// way here, so the replay runs a judge on these traces too.
module pagesWithAReviewer {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAChatRequest, REFINER = AReviewer, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2), STAGE_ENDING = AcceptanceEnding).* from "./workflowLifecycle"
}
