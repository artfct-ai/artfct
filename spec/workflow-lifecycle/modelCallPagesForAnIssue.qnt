/// A workflow starts from a tracker issue, and the author of each job writes its page with model
/// calls. A person presses Stop in the session of the subject issue, also while a model call is
/// out.
module modelCallPagesForAnIssue {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PagesForAnIssue, REFINER = NoRefiner, MODEL_AUTHOR = true, RESEARCH = false, SLOT_COUNTS = 1.to(2), STAGE_ENDING = AcceptanceEnding).* from "./workflowLifecycle"
}
