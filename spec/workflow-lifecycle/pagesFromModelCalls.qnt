/// The author of each job writes its page with model calls, and the humans get the page as the
/// author leaves it. A plan sets one to three job slots, so a later plan can set fewer than the
/// jobs that run.
module pagesFromModelCalls {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAChatRequest, REFINER = NoRefiner, MODEL_AUTHOR = true, RESEARCH = false, SLOT_COUNTS = 1.to(3), STAGE_ENDING = AcceptanceEnding).* from "./workflowLifecycle"
}
