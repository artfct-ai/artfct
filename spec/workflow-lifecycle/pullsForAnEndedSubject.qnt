/// A workflow starts from a tracker issue. Each job opens a pull for the subject issue or
/// continues one, and a person ends the subject issue on the tracker.
module pullsForAnEndedSubject {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = PullsForAnEndedSubject, REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
