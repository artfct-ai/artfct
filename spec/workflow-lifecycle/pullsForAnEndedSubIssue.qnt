/// A workflow starts from a tracker issue. Each job opens a pull for a sub-issue or continues one,
/// and a person ends the sub-issue or the subject issue on the tracker.
module pullsForAnEndedSubIssue {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PullsForAnEndedSubIssue, REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2), STAGE_ENDING = AcceptanceEnding).* from "./workflowLifecycle"
}
