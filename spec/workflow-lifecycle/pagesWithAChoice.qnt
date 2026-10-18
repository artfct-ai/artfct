/// Each job writes a page that lists options, and the job completes once a person selects one.
module pagesWithAChoice {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAChatRequest, REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2), STAGE_ENDING = ChoiceEnding).* from "./workflowLifecycle"
}
