/**
 * The work tracker capability: issues, workflow states, users, and agent sessions.
 * Consumers program against `Tracker`. Linear implements it today. Documents live in `../documents`.
 */
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ExternalUser } from "@artfct-ai/contracts/types";

/** Resolves a tracker user to a person the orchestrator trusts, or to null. */
export type TrackerActorResolver = (user: ExternalUser) => Promise<Actor | null>;

/** A normalized event ready to deliver, or the reason the webhook is ignored. */
export type TrackerInbound = { event: InboundEvent } | { ignore: string };

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
  /** Label names as Linear shows them, for example `harness: opencode`. */
  labels: string[];
  blockers: Array<{ id: string; identifier: string; state: { type: StateType } }>;
};

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

/** Options for `Tracker.activity`. */
export type ActivityOptions = { ephemeral?: boolean; externalUrls?: ExternalUrl[] };

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
   * Show a link on an issue. A tracker that recognizes the URL renders it through its own
   * integration, so a chat thread reads as that thread and not as a bare link.
   */
  attachUrl(issueId: string, url: string): Promise<void>;
  /** One issue by id or identifier (`ENG-42`), with its blockers. Null when there is none. */
  issue(idOrKey: string): Promise<TrackerIssue | null>;
  /** Every issue of a project, with blockers. */
  projectIssues(projectId: string): Promise<TrackerIssue[]>;
  activity(
    sessionId: string,
    content: AgentActivityContent,
    options?: ActivityOptions,
  ): Promise<void>;
}
