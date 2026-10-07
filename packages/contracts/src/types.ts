/** The contract between ingress and the orchestrator. Plain types only. */
import type { Actor, InboundEvent } from "./inbound";
import type { BindingSource } from "./sources";

/** Acknowledgement returned by every Workflow RPC that takes an event. */
export type RpcAck = { ok: true; workflow_id?: string; duplicate?: boolean };

/** Lifecycle of one workflow. */
export type WorkflowStatus =
  | "new"
  | "planning"
  | "running"
  | "waiting_input"
  | "done"
  | "cancelled"
  | "failed";

/** Lifecycle of one coding task. The board renders one column per status. */
export const TASK_STATUSES = [
  "queued",
  "provisioning",
  "working",
  "in_review",
  "done",
  "cancelled",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** What a stage produces for review, in capability terms. The stage config validates against it. */
export const ARTIFACT_KINDS = ["pull", "page", "issues"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Who owns an artifact right now. `drafted`: the agents, and the humans are not told. `ready`:
 * the humans, and it is announced. `accepted`: the host closed it. `removed`: the host no longer
 * holds it as work.
 */
export type ArtifactStatus = "drafted" | "ready" | "accepted" | "removed";

/**
 * One running or reviewed job in a status summary. Status, harness, and cost are its author's.
 * The harness is null for a model-call author.
 */
export type JobSummary = {
  job_id: string;
  stage: string;
  status: TaskStatus;
  harness: string | null;
  branch: string | null;
  /** The Linear issue identifier the job works on, for example ENG-42. */
  issue: string | null;
  cost_usd: number;
  artifact: { kind: ArtifactKind; url: string; status: ArtifactStatus } | null;
};

/** One workflow as an admin or a status reply sees it. */
export type WorkflowSummary = {
  workflow_id: string;
  status: WorkflowStatus;
  /** The planned stages, in order. A guide for the agent, not a state machine. */
  stages: string[];
  /** Jobs whose author task is not finished. */
  jobs: JobSummary[];
  concurrency: number;
  cost_usd: number;
  repo: { full: string } | null;
  reason: string;
};

/** A user as reported by an external system. */
export type ExternalUser = { id: string; email?: string | null; name?: string | null };

/**
 * A chat user. `member_of_team` is the chat team the user is a full member of. It is null for a
 * guest, a bot, and a user the chat vendor could not look up.
 */
export type ChatUser = ExternalUser & { member_of_team: string | null };

/**
 * A code host login acting on one repository. `app` is true for an App, which the repository
 * authorized by installing it.
 */
export type CodeUser = { login: string; repo: string; app: boolean };

/** Who to resolve to a person. One variant per capability. */
export type IdentityQuery =
  | { source: "tracker"; user: ExternalUser }
  | { source: "chat"; user: ChatUser }
  | { source: "code"; user: CodeUser }
  | { source: "documents"; user: ExternalUser };

/** What happened to a delivered event. `joined` means a start event landed on an existing workflow. */
export type Delivery =
  | { workflow_id: string; created: boolean; joined?: boolean; result: RpcAck }
  | { dropped: string }
  | { fanned_out: number; results: RpcAck[] };

/** What the Linear OAuth callback hands over to complete an agent install. */
export type LinearInstallInput = { code: string; state: string; redirect_uri: string };

/** An install link for a workspace admin, or the reason none can be made. */
export type LinearInstallLink = { url: string } | { error: string };

/** The outcome of a Linear agent install. */
export type LinearInstallResult =
  | { installed: true; organization: string; app_user_id: string }
  | { installed: false; error: string };

/** One binding as listed for admins. */
export type BindingRecord = {
  source: BindingSource;
  external_id: string;
  workflow_id: string;
  created_at: string;
};

/** The RPC surface of the orchestrator Worker. Ingress calls it through a service binding. */
export interface OrchestratorRpc {
  /** Route an event to its workflow. Unbound start events create one. */
  deliver(event: InboundEvent): Promise<Delivery>;
  /** Resolve an external user to an authorized actor, or null. */
  resolveActor(query: IdentityQuery): Promise<Actor | null>;
  /** The id of the tracker workspace the deployment is installed in. Null before the install. */
  trackerWorkspace(): Promise<string | null>;
  status(workflowId: string): Promise<WorkflowSummary>;
  debug(workflowId: string): Promise<unknown>;
  bindings(): Promise<BindingRecord[]>;
  /** A fresh Linear authorize link for an app-actor install. The state inside it works once. */
  linearInstallUrl(input: { redirect_uri: string }): Promise<LinearInstallLink>;
  /** Complete an install from the OAuth callback: spend the state, exchange the code, store tokens. */
  linearInstall(input: LinearInstallInput): Promise<LinearInstallResult>;
  /** Carries the bridge WebSocket upgrade to the Workflow Durable Object that owns the socket. */
  fetch(request: Request): Promise<Response>;
}
