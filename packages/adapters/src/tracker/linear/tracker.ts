/**
 * The Linear work tracker over the official `@linear/sdk`. Consumers see only the plain types
 * from `./types`. SDK model classes stay inside this file.
 */
import { LinearSdk, type LinearOptions, type TokenSource } from "./sdk";
import { fetchIssue, fetchProjectIssues, type RawQuery } from "./issues";
import type {
  ActivityOptions,
  AgentActivityContent,
  AppUser,
  ExternalUrl,
  IssueUpdate,
  SessionPlanItem,
  TeamMembership,
  Tracker,
  TrackerIssue,
  TrackerUser,
  WorkflowState,
} from "../types";

/** Construction options. `appUserId` is the agent's own user id, known for an app-actor install. */
export type LinearTrackerOptions = LinearOptions & { appUserId?: string };

/** How Linear words the refusal to sync a Slack thread that already syncs into another issue. */
const ALREADY_SYNCED_MESSAGE = "already synced";

/** True when Linear refused a sync because the thread already syncs into another issue. */
function isAlreadySyncedError(error: unknown): boolean {
  return errorMessages(error).some((message) => message.includes(ALREADY_SYNCED_MESSAGE));
}

/** How Linear words the refusal of an activity whose id another activity has already. */
const REPEATED_ACTIVITY = "conflict on insert of AgentActivity";

/** True when Linear refused an activity because one with its id exists already. */
function isRepeatedActivity(error: unknown): boolean {
  return errorMessages(error).some((message) => message.includes(REPEATED_ACTIVITY));
}

/** Every message an error carries, including the GraphQL errors a `LinearError` lists. */
function errorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const nested: unknown[] = "errors" in error && Array.isArray(error.errors) ? error.errors : [];
  return [error.message, ...nested.map(messageOf)];
}

function messageOf(item: unknown): string {
  if (typeof item === "object" && item !== null && "message" in item) return String(item.message);
  return String(item);
}

/** Linear requires a label on every session link. The URL stands in when the caller has none. */
function toExternalUrlInput(url: ExternalUrl): { url: string; label: string } {
  return { url: url.url, label: url.label ?? url.url };
}

/**
 * Linear tracker. Authenticates with a fixed token, or with a token source that is asked on
 * every call so a refreshed OAuth token is picked up.
 */
export class LinearTracker implements Tracker {
  /** The agent's user id under an app-actor install. Null under a personal API key. */
  readonly appUserId: string | null;
  private readonly sdk: LinearSdk;

  constructor(token: string | TokenSource, options: LinearTrackerOptions = {}) {
    this.appUserId = options.appUserId ?? null;
    this.sdk = new LinearSdk(token, options);
  }

  private client() {
    return this.sdk.client();
  }

  /** Run one GraphQL document through the SDK's transport. Throws a `LinearError` on failure. */
  private readonly raw: RawQuery = async <Data>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Data> => {
    const client = await this.client();
    const response = await client.client.rawRequest<Data, Record<string, unknown>>(
      query,
      variables,
    );
    if (response.data === undefined) throw new Error("linear: response without data");
    return response.data;
  };

  async appUser(): Promise<AppUser> {
    const client = await this.client();
    const viewer = await client.viewer;
    const organization = await viewer.organization;
    return {
      id: viewer.id,
      name: viewer.name,
      organization: { id: organization.id, name: organization.name },
    };
  }

  /** Membership of a team named by id or key. Linear accepts either in `team(id:)`. */
  async teamMembership(teamIdOrKey: string, userId: string): Promise<TeamMembership> {
    const client = await this.client();
    const team = await client.team(teamIdOrKey);
    const members = await team.members({ filter: { id: { eq: userId } } });
    return { team_id: team.id, member: members.nodes.length > 0 };
  }

  async userByEmail(email: string): Promise<TrackerUser | null> {
    const client = await this.client();
    const users = await client.users({ filter: { email: { eq: email } } });
    const user = users.nodes[0];
    return user ? { id: user.id, name: user.name } : null;
  }

  async teamStates(teamId: string): Promise<WorkflowState[]> {
    const client = await this.client();
    const team = await client.team(teamId);
    const states = await team.states();
    return states.nodes
      .map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        position: state.position,
      }))
      .toSorted((left, right) => left.position - right.position);
  }

  async updateIssue(issueId: string, input: IssueUpdate): Promise<void> {
    const client = await this.client();
    await client.updateIssue(issueId, input);
  }

  /**
   * Sync a Slack thread into the issue's comments. Linear syncs one thread into one issue, so a
   * thread synced elsewhere gets a plain link, which Linear renders through its Slack integration.
   */
  async syncChatThread(issueId: string, threadUrl: string): Promise<void> {
    const client = await this.client();
    try {
      await client.attachmentLinkSlack(issueId, threadUrl, { syncToCommentThread: true });
    } catch (error) {
      if (!isAlreadySyncedError(error)) throw error;
      await client.attachmentLinkURL(issueId, threadUrl);
    }
  }

  issue(idOrKey: string): Promise<TrackerIssue | null> {
    return fetchIssue(this.raw, idOrKey);
  }

  projectIssues(projectId: string): Promise<TrackerIssue[]> {
    return fetchProjectIssues(this.raw, projectId);
  }

  /**
   * Emit an agent activity. Linear refuses a second activity with the same id, and that refusal
   * means the first post landed. `externalUrls` belong to the session, so they go in a second call.
   */
  async activity(
    sessionId: string,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    const client = await this.client();
    try {
      await client.createAgentActivity({
        agentSessionId: sessionId,
        content,
        ephemeral: options.ephemeral ?? false,
        ...(options.id ? { id: options.id } : {}),
      });
    } catch (error) {
      if (!options.id || !isRepeatedActivity(error)) throw error;
    }
    if (!options.externalUrls?.length) return;
    await client.updateAgentSession(sessionId, {
      addedExternalUrls: options.externalUrls.map(toExternalUrlInput),
    });
  }

  async setSessionPlan(sessionId: string, plan: SessionPlanItem[]): Promise<void> {
    const client = await this.client();
    await client.updateAgentSession(sessionId, { plan });
  }
}
