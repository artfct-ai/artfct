/// A workflow starts from a tracker issue. Each job opens a pull for the subject issue or its
/// sub-issue, or continues one, while the host and the tracker do not move them.
module pullsForTwoIssues {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PullsForTwoIssues, REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
