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
/** Task ID. Format `<conversationId>.<sequence>`. */
export type TaskId = string;
/** Job ID. Format `<conversationId>-<sequence>`. */
export type JobId = string;

/** New random workflow ID. */
export function newWorkflowId(): WorkflowId {
  return `wf_${randomBase32(10)}`;
}

/** Task IDs embed the conversation ID and a sequence number. */
export function taskId(conversationId: string, seq: number): TaskId {
  return `${conversationId}.${seq}`;
}

/** Job IDs embed the conversation ID and a sequence number of their own. */
export function jobId(conversationId: string, seq: number): JobId {
  return `${conversationId}-${seq}`;
}

/** The sequence number embedded in a job ID. Null when the text is not a job ID. */
export function sequenceFromJobId(id: JobId): number | null {
  const match = /^[a-z]+_[a-z2-7]+-(\d+)$/.exec(id);
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
  const match = /^([a-z]+_[a-z2-7]+-\d+)-/.exec(branch.slice(ORCHESTRATOR_BRANCH_PREFIX.length));
  return match?.[1] ?? null;
}
