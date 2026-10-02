import { createHash } from "node:crypto";
import type { ArtifactTarget } from "../../artifact/types";
import type { JobInput, JobIssue } from "../lifecycle";
import type { WorkflowRuntime } from "../types";

/** What the agent named when it started a job: an issue, an artifact target, or neither. */
export type NamedInput = { issue: JobIssue | null; target: ArtifactTarget | null };

/**
 * The input of a job to start. An issue is its input, else the artifact the request points at.
 * With neither, the job builds on the artifact of the latest completed job whose artifact is
 * ready or accepted. Otherwise it works from the request.
 */
export function jobInputFor(
  workflow: WorkflowRuntime,
  named: NamedInput,
  requestText: string,
): JobInput {
  if (named.issue) return { kind: "issue", issue: named.issue };
  if (named.target) return { kind: "target", target: named.target };
  const builtOn = workflow.store
    .jobs()
    .filter((job) => {
      if (workflow.store.authorTask(job.job_id)?.status !== "done") return false;
      const status = workflow.store.artifact(job.job_id)?.status;
      return status === "ready" || status === "accepted";
    })
    .at(-1);
  if (builtOn) return { kind: "artifact", jobId: builtOn.job_id };
  return { kind: "request", text: requestText };
}

/** The `input_key` of a job. Each arm of the input has its own form, so two arms never share a key. */
export function jobInputKey(input: JobInput): string {
  if (input.kind === "issue") return input.issue.id;
  if (input.kind === "target") return artifactRefKey(input.target);
  if (input.kind === "artifact") return `artifact:${input.jobId}`;
  return `request:${createHash("sha256").update(input.text).digest("hex")}`;
}

/** The key of an artifact target, from its ref. An issue set has no fields, so its link is the key. */
export function artifactRefKey({ ref, url }: ArtifactTarget): string {
  if (ref.kind === "page") return `page:${ref.page_id}`;
  if (ref.kind === "pull") return `pull:${ref.repo}#${ref.number}`;
  return `issues:${url}`;
}
