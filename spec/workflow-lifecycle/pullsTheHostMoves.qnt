/// A workflow starts from a tracker issue. Each job opens a pull for the subject issue or
/// continues one, and the host merges, closes and reopens pulls.
module pullsTheHostMoves {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PullsTheHostMoves, REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
