import { ORCHESTRATOR_BRANCH_PREFIX } from "@artfct-ai/adapters/code/branch-prefix";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Random lowercase base32 text. Safe in URLs and branch names. */
function randomBase32(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += BASE32_ALPHABET[byte % 32];
  return out;
}

/** Workflow ID. Format `wf_<base32>`. */
export type WorkflowId = string;
/** Task ID. Format `<workflowId>.<sequence>`. */
export type TaskId = string;
/** Job ID. Format `<workflowId>-<sequence>`. */
export type JobId = string;
/** Person ID. Format `p_<base32>`. */
export type PersonId = string;

/** New random workflow ID. */
export function newWorkflowId(): WorkflowId {
  return `wf_${randomBase32(10)}`;
}

/** New random person ID. */
export function newPersonId(): PersonId {
  return `p_${randomBase32(10)}`;
}

/** Task IDs embed the workflow ID and a sequence number. */
export function taskId(workflowId: WorkflowId, seq: number): TaskId {
  return `${workflowId}.${seq}`;
}

/** The workflow ID embedded in a task ID. Null when the text is not a task ID. */
export function workflowIdFromTaskId(id: TaskId): WorkflowId | null {
  const match = /^(wf_[a-z2-7]+)\.\d+$/.exec(id);
  return match?.[1] ?? null;
}

/** Job IDs embed the workflow ID and a sequence number of their own. */
export function jobId(workflowId: WorkflowId, seq: number): JobId {
  return `${workflowId}-${seq}`;
}

/** The sequence number embedded in a job ID. Null when the text is not a job ID. */
export function sequenceFromJobId(id: JobId): number | null {
  const match = /^wf_[a-z2-7]+-(\d+)$/.exec(id);
  return match?.[1] ? Number(match[1]) : null;
}

/** New random 32 character secret token. */
export function newToken(): string {
  return randomBase32(32);
}

/** Lowercase, dash-separated slug of at most `max` characters. Falls back to "task". */
export function slugify(text: string, max = 32): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "task"
  );
}

/** Branch name carries the ID of the job that created it. A later job may continue its artifact on it. */
export function branchName(id: JobId, title: string): string {
  return `${ORCHESTRATOR_BRANCH_PREFIX}${id}-${slugify(title)}`;
}

/** The job ID encoded in a branch name. Null when the branch is not ours. */
export function jobIdFromBranch(branch: string): JobId | null {
  if (!branch.startsWith(ORCHESTRATOR_BRANCH_PREFIX)) return null;
  const match = /^(wf_[a-z2-7]+-\d+)-/.exec(branch.slice(ORCHESTRATOR_BRANCH_PREFIX.length));
  return match?.[1] ?? null;
}
