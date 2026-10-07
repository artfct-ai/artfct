import { jobIdFromBranch } from "../../ids";
import { pullDetailOf } from "../../artifact/pull";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { JobRow } from "../store/tasks";
import type { Applied, WorkflowRuntime } from "../types";

/** The job of the only active author or researcher task, or null when there are none or several. */
function singleActiveJob(workflow: WorkflowRuntime): JobRow | null {
  const active = workflow.store.activeAuthorAndResearcherTasks();
  return active.length === 1 ? workflow.store.requireJob(active[0]!.job_id) : null;
}

/**
 * The job an event is about, by pull request, branch, or binding. With one active author or
 * researcher task and no named pull request, its job. Otherwise null.
 */
export function jobForEvent(workflow: WorkflowRuntime, event: InboundEvent): JobRow | null {
  const named = byPullRequest(workflow, event) ?? byBinding(workflow, event);
  if (named) return named;
  return namesOnePull(event) ? null : singleActiveJob(workflow);
}

/** True when the event is about one named pull request. A push to a base branch names none. */
function namesOnePull(event: InboundEvent): boolean {
  return pullDetailOf(event) !== null;
}

/**
 * The jobs an event may be about: the one it names, or every job holding an open artifact plus
 * the job of the only active author or researcher task. Empty for a named pull request nothing here matches.
 */
export function jobsForEvent(workflow: WorkflowRuntime, event: InboundEvent): JobRow[] {
  const named = byPullRequest(workflow, event) ?? byBinding(workflow, event);
  if (named) return [named];
  if (namesOnePull(event)) return [];
  const candidates = workflow.store
    .openArtifacts()
    .map((artifact) => workflow.store.requireJob(artifact.job_id));
  const single = singleActiveJob(workflow);
  if (single && !candidates.some((job) => job.job_id === single.job_id)) candidates.push(single);
  return candidates;
}

function byPullRequest(workflow: WorkflowRuntime, event: InboundEvent): JobRow | null {
  const pull = pullDetailOf(event);
  if (!pull) return null;
  const artifact = workflow.store.artifactByPull(pull.repo, pull.number);
  if (artifact) return workflow.store.requireJob(artifact.job_id);
  if (!pull.branch) return null;
  const embedded = jobIdFromBranch(pull.branch);
  const byId = embedded ? workflow.store.job(embedded) : null;
  return byId ?? workflow.store.jobByBranch(pull.branch);
}

/** The job working on a tracker issue the event names, if any. */
export function jobByIssueBinding(workflow: WorkflowRuntime, event: InboundEvent): JobRow | null {
  for (const binding of event.bindings) {
    if (binding.source !== "tracker_issue") continue;
    const job = workflow.store.jobByIssue(binding.external_id);
    if (job) return job;
  }
  return null;
}

function byBinding(workflow: WorkflowRuntime, event: InboundEvent): JobRow | null {
  for (const binding of event.bindings) {
    const job = jobByBinding(workflow, binding);
    if (job) return job;
  }
  return null;
}

/** An issue names the job that works on it. A document names the job whose artifact it is. */
function jobByBinding(workflow: WorkflowRuntime, binding: Binding): JobRow | null {
  switch (binding.source) {
    case "tracker_issue":
      return workflow.store.jobByIssue(binding.external_id);
    case "documents_page": {
      const artifact = workflow.store.artifactByPage(binding.external_id);
      return artifact ? workflow.store.requireJob(artifact.job_id) : null;
    }
    default:
      return null;
  }
}

/** The note for an event no job matches. With several active jobs the agent must ask which. */
export function noMatchingJobNote(workflow: WorkflowRuntime): Applied {
  const active = workflow.store.activeAuthorAndResearcherTasks();
  if (!active.length) return { notes: ["No job is running. Nothing was recorded."], wake: "none" };
  const ids = active.map((task) => task.job_id).join(", ");
  return {
    notes: [`No job matches this event. Active jobs: ${ids}. Ask which job it is about.`],
    wake: "blocked",
  };
}
