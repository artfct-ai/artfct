/// A workflow starts from a request in a chat thread, without a subject. Each job of the breakdown
/// stage writes issues for the request or for an issue, and ends with the link of the subject
/// issue or the project. The plan or the first output sets the subject.
module issuesForAChatRequest {
  import workflowLifecycleTypes.* from "./workflowLifecycle"
  import workflowLifecycle(WORK = IssuesForAChatRequest, REFINER = NoRefiner, MODEL_AUTHOR = false, RESEARCH = false, SLOT_COUNTS = Set(2)).* from "./workflowLifecycle"
}
