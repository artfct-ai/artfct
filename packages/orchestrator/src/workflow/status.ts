import type { JobSummary, WorkflowSummary } from "@artfct-ai/contracts/types";
import type { TaskRow } from "./store/tasks";
import type { WorkflowRuntime } from "./types";

/** Status summary: the plan, the active jobs with their artifacts, and the cost. */
export function summarize(workflow: WorkflowRuntime): WorkflowSummary {
  const { state } = workflow;
  return {
    workflow_id: state.workflow_id,
    status: state.status,
    stages: state.stages,
    jobs: workflow.store.activeAuthorAndResearcherTasks().map((task) => jobSummary(workflow, task)),
    concurrency: state.concurrency,
    cost_usd: workflow.store.workflowCost(),
    repo: state.repo,
    reason: state.reason,
  };
}

function jobSummary(workflow: WorkflowRuntime, task: TaskRow): JobSummary {
  const job = workflow.store.requireJob(task.job_id);
  const artifact = workflow.store.artifact(job.job_id);
  const jobCost = workflow.store
    .tasks()
    .filter((jobTask) => jobTask.job_id === job.job_id)
    .reduce((total, jobTask) => total + jobTask.cost_usd, 0);
  return {
    job_id: job.job_id,
    stage: job.stage,
    status: task.status,
    harness: workflow.store.sandbox(task.task_id)?.harness ?? null,
    branch: job.branch,
    issue: job.issue_key,
    cost_usd: jobCost,
    artifact: artifact
      ? { kind: artifact.kind, url: artifact.external_url, status: artifact.status }
      : null,
  };
}

/** The summary as a short message for chat channels. */
export function statusText(summary: WorkflowSummary): string {
  const jobs = summary.jobs.length
    ? summary.jobs.map(
        (job) =>
          `Job ${job.job_id}${issueText(job)} [${job.stage}]: ${job.status}${artifactText(job)}`,
      )
    : ["Jobs: none"];
  return [
    `Workflow ${summary.workflow_id}: ${summary.status}`,
    `Plan: ${summary.stages.length ? summary.stages.join(" -> ") : "none"}`,
    ...jobs,
    `Cost so far: $${summary.cost_usd.toFixed(2)}`,
  ].join("\n");
}

function issueText(job: JobSummary): string {
  return job.issue ? ` (${job.issue})` : "";
}

function artifactText(job: JobSummary): string {
  return job.artifact ? `, ${job.artifact.url} (${job.artifact.status})` : "";
}

/** Everything in storage, for the smoke test and debugging. Bridge tokens are masked. */
export function debugDump(workflow: WorkflowRuntime) {
  const { store } = workflow;
  return {
    state: workflow.state,
    jobs: store.jobs(),
    tasks: store.tasks().map((task) => {
      const sandbox = store.sandbox(task.task_id);
      return { ...task, sandbox: sandbox && { ...sandbox, bridge_token: "***" } };
    }),
    artifacts: store.artifacts(),
    boards: store.allBoards(),
    todos: store.allTodoRows(),
    model_usage: store.modelUsage(),
    outbox: store.outbox(),
    queue: store.queue(),
    log: store.logLines(),
    inbox: [...workflow.transcript.taken(), ...workflow.transcript.inbox()],
    transcript: workflow.transcript.all(),
    connections: workflow.connections().length,
  };
}
