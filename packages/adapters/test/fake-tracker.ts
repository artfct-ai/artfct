import type {
  ActivityOptions,
  AgentActivityContent,
  AppUser,
  IssueUpdate,
  TeamMembership,
  Tracker,
  TrackerIssue,
  TrackerUser,
  WorkflowState,
} from "../src/tracker/types";
import { CallLog, type RecordedCall } from "./calls";

/** The agent's own user, as a tracker reports the viewer of an app-actor token. */
export const APP_USER: AppUser = {
  id: "app1",
  name: "Agent",
  organization: { id: "org1", name: "Acme" },
};

/** The workflow states of team-1, out of board order. */
export const TEAM_STATES: WorkflowState[] = [
  { id: "st-done", name: "Done", type: "completed", position: 4 },
  { id: "st-approved", name: "approved", type: "started", position: 3 },
  { id: "st-progress", name: "In Progress", type: "started", position: 2 },
  { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
];

/** Fixed answers. Anything left out gets the default named on each field. */
export type TrackerAnswers = {
  appUserId?: string | null;
  appUser?: AppUser;
  /** Team states in board order. Default `TEAM_STATES` sorted by position. */
  states?: WorkflowState[];
  /** The team the membership query resolves to and who its members are. */
  team?: { id: string; members: string[] };
  usersByEmail?: Record<string, TrackerUser>;
  issue?: TrackerIssue | null;
  issues?: TrackerIssue[];
  /** Every call fails. */
  failing?: boolean;
};

/** Methods a `FakeTracker` records. */
export type TrackerMethod = Exclude<keyof Tracker, "appUserId">;

/** An in-memory `Tracker` that answers from `TrackerAnswers` and records every call. */
export class FakeTracker implements Tracker {
  readonly appUserId: string | null;
  private readonly log: CallLog<TrackerMethod>;

  constructor(private readonly answers: TrackerAnswers = {}) {
    this.appUserId = answers.appUserId ?? null;
    this.log = new CallLog(answers.failing ?? false);
  }

  /** Every call so far, in order. */
  get calls(): RecordedCall<TrackerMethod>[] {
    return this.log.calls;
  }

  /** The argument lists of every call to `method`. */
  argsOf(method: TrackerMethod): unknown[][] {
    return this.log.argsOf(method);
  }

  async appUser(): Promise<AppUser> {
    this.log.record("appUser");
    return this.answers.appUser ?? APP_USER;
  }

  async teamMembership(teamIdOrKey: string, userId: string): Promise<TeamMembership> {
    this.log.record("teamMembership", teamIdOrKey, userId);
    const team = this.answers.team ?? { id: teamIdOrKey, members: [] };
    return { team_id: team.id, member: team.members.includes(userId) };
  }

  async userByEmail(email: string): Promise<TrackerUser | null> {
    this.log.record("userByEmail", email);
    return this.answers.usersByEmail?.[email] ?? null;
  }

  async teamStates(teamId: string): Promise<WorkflowState[]> {
    this.log.record("teamStates", teamId);
    const states = this.answers.states ?? TEAM_STATES;
    return states.toSorted((left, right) => left.position - right.position);
  }

  async updateIssue(issueId: string, input: IssueUpdate): Promise<void> {
    this.log.record("updateIssue", issueId, input);
  }

  async attachUrl(issueId: string, url: string): Promise<void> {
    this.log.record("attachUrl", issueId, url);
  }

  async issue(idOrKey: string): Promise<TrackerIssue | null> {
    this.log.record("issue", idOrKey);
    return this.answers.issue ?? null;
  }

  async projectIssues(projectId: string): Promise<TrackerIssue[]> {
    this.log.record("projectIssues", projectId);
    return this.answers.issues ?? [];
  }

  async activity(
    sessionId: string,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    this.log.record("activity", sessionId, content, options);
  }
}
