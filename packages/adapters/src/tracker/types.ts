/**
 * The work tracker capability: issues, workflow states, users, and agent sessions.
 * Consumers program against `Tracker`. Linear implements it today. Documents live in `../documents`.
 */
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ExternalUser, VendorEvent } from "@artfct-ai/contracts/types";

/** Resolves a tracker user to a person the orchestrator trusts, or to null. */
export type TrackerActorResolver = (user: ExternalUser) => Promise<Actor | null>;

/** A normalized event ready to deliver, or the reason the webhook is ignored. */
export type TrackerInbound = { event: InboundEvent } | { ignore: string };

/** What the tracker's vendor pass-through makes of a verified delivery: a vendor event, or a drop with its reason. */
export type TrackerVendorEvent = { event: VendorEvent } | { drop: string };

/** What a tracker webhook mapper needs besides the payload. */
export type TrackerInboundContext = {
  /** The workspace the deployment is installed in. Null before the install. */
  workspaceId: string | null;
  resolveActor: TrackerActorResolver;
  /** The header the tracker stamps each delivery with. Null when it sends none. */
  deliveryId: string | null;
};

/** A workflow state type. `completed` and `canceled` count as finished. */
export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** One issue with its labels and the issues that block it. */
export type TrackerIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { type: StateType; name: string };
  team_id: string | null;
  /** The issue this one is a sub-issue of. Null for a top-level issue. */
  parent_id: string | null;
  /** The tracker project the issue belongs to. Null when it belongs to none. */
  project_id: string | null;
  /** Label names as Linear shows them, for example `harness: opencode`. */
  labels: string[];
  blockers: Array<{ id: string; identifier: string; state: { type: StateType } }>;
};

/** A tracker project, which holds issues. */
export type TrackerProject = { id: string; name: string; url: string };

/** A team workflow state, with its board position. */
export type WorkflowState = { id: string; name: string; type: string; position: number };

/** A tracker user. */
export type TrackerUser = { id: string; name: string };

/** The user a credential acts as. For an app-actor token this is the agent itself. */
export type AppUser = { id: string; name: string; organization: { id: string; name: string } };

/** A team membership answer. `team_id` is the resolved id when the query named the team by key. */
export type TeamMembership = { team_id: string; member: boolean };

/** The issue fields the orchestrator sets. Both go in one call. */
export type IssueUpdate = { stateId?: string; delegateId?: string };

/** Content of one agent session activity. */
export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** A link shown on an agent session. */
export type ExternalUrl = { url: string; label?: string };

/** Options for posting an activity. A post with an `id` already used does not add a second one. */
export type ActivityOptions = { ephemeral?: boolean; externalUrls?: ExternalUrl[]; id?: string };

/**
 * What the tracker said is left of the request quota of its user, as of its last answer that
 * said. `resets_at` is when the quota fills again, in epoch milliseconds.
 */
export type RequestQuota = { remaining: number; limit: number; resets_at: number };

/** One step of an agent session plan. */
export type SessionPlanItem = {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
};

/** Tokens a tracker's OAuth grant returns. `expires_in` is in seconds. */
export type TrackerTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

/** The tracker's OAuth app: the link an admin installs it from, and the token grants. */
export interface TrackerOAuth {
  /** The URL the admin opens in a browser to install the app. */
  authorizeUrl(input: { redirectUri: string; state: string }): string;
  /** Trade the authorization code from the callback for tokens. */
  exchangeCode(input: { code: string; redirectUri: string }): Promise<TrackerTokens>;
  /** Trade a refresh token for a new access token and refresh token. */
  refreshTokens(refreshToken: string): Promise<TrackerTokens>;
}

/** What the orchestrator asks of a work tracker. */
export interface Tracker {
  /** The agent's own user id under an app install. Null under a personal API key. */
  readonly appUserId: string | null;
  appUser(): Promise<AppUser>;
  /** Membership of a team named by id or key (`ENG`). */
  teamMembership(teamIdOrKey: string, userId: string): Promise<TeamMembership>;
  userByEmail(email: string): Promise<TrackerUser | null>;
  /** Workflow states of a team, ordered by position. */
  teamStates(teamId: string): Promise<WorkflowState[]>;
  updateIssue(issueId: string, input: IssueUpdate): Promise<void>;
  /**
   * Make a chat thread the issue's comment thread, so each side shows the other's replies. A
   * thread already synced to another issue gets a plain link on this one instead.
   */
  syncChatThread(issueId: string, threadUrl: string): Promise<void>;
  /** One issue by id or identifier (`ENG-42`), with its blockers. Null when there is none. */
  issue(idOrKey: string): Promise<TrackerIssue | null>;
  /** The direct sub-issues of an issue, with blockers. */
  subIssues(parentId: string): Promise<TrackerIssue[]>;
  /** One project by id or by the slug id its URL ends with. Null when there is none. */
  project(idOrSlug: string): Promise<TrackerProject | null>;
  /** Every issue of a project, with blockers. */
  projectIssues(projectId: string): Promise<TrackerIssue[]>;
  activity(
    sessionId: string,
    content: AgentActivityContent,
    options?: ActivityOptions,
  ): Promise<void>;
  /** Replace the plan of an agent session. */
  setSessionPlan(sessionId: string, plan: SessionPlanItem[]): Promise<void>;
  /** The request quota as the last answer that named it said. Null before any answer did. */
  requestQuota(): RequestQuota | null;
}
