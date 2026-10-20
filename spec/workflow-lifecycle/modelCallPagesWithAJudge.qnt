/// The author of each job writes its page with model calls, and a judge rules on a revision
/// before the humans get it. A later revision goes to the humans without another judge run.
module modelCallPagesWithAJudge {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAChatRequest, REFINER = AJudge, MODEL_AUTHOR = true, RESEARCH = false, SLOT_COUNTS = Set(2), STAGE_ENDING = AcceptanceEnding).* from "./workflowLifecycle"
}
