/**
 * Webhook payload builders shaped like the real Linear, GitHub, and Slack deliveries. The
 * normalizers read a few fields. The rest is carried so the smoke exercises the real shape.
 */
import { REPO_FULL_NAME, RUN_ID } from "./config";

import { docUrlForStage } from "../../packages/bridge/test/mock-harness-turn";

export { docUrlForStage };

/** The 32 hex char Notion page id the orchestrator binds for a stage's document. */
export function notionPageId(stage: string): string {
  return /([0-9a-f]{32})$/.exec(docUrlForStage(stage))![1]!;
}

/** A GitHub account as it appears in `user`, `owner`, and `sender` fields. */
export type GithubAccount = { login: string; id: number; node_id: string; type: string };

/** Pull request object as GitHub sends it inside `pull_request` events. */
export type PullRequestFixture = {
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  locked: boolean;
  title: string;
  user: GithubAccount;
  body: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  html_url: string;
  url: string;
  draft: boolean;
  merged: boolean;
  head: { label: string; ref: string; sha: string; user: GithubAccount; repo: RepositoryFixture };
  base: { label: string; ref: string; sha: string; user: GithubAccount; repo: RepositoryFixture };
  author_association: string;
};

/** Repository object as GitHub sends it in every event. */
export type RepositoryFixture = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: GithubAccount;
  html_url: string;
  default_branch: string;
};

const [OWNER_LOGIN, REPO_NAME] = REPO_FULL_NAME.split("/") as [string, string];

/** The organization that owns the smoke repository. */
export const ownerFixture: GithubAccount = {
  login: OWNER_LOGIN,
  id: 9919,
  node_id: "O_kgDOAAAmvw",
  type: "Organization",
};

/** The team member who reviews and merges in the smoke. */
export const samFixture: GithubAccount = {
  login: "sam",
  id: 1001,
  node_id: "U_kgDOAAAD6Q",
  type: "User",
};

/** The GitHub App identity the harness pushes and opens PRs as. */
export const agentBotFixture: GithubAccount = {
  login: "artfct-agent[bot]",
  id: 2002,
  node_id: "BOT_kgDOAAAH0g",
  type: "Bot",
};

export const repositoryFixture: RepositoryFixture = {
  id: 583231,
  node_id: "R_kgDOIvd0Bw",
  name: REPO_NAME,
  full_name: REPO_FULL_NAME,
  private: true,
  owner: ownerFixture,
  html_url: `https://github.com/${REPO_FULL_NAME}`,
  default_branch: "main",
};

/** The GitHub App installation every event of the smoke repository carries. */
export const installationFixture = {
  id: 41522,
  node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNDE1MjI=",
};

/** Head commit of the task branch. */
export const HEAD_SHA = "abc1234def5678abc1234def5678abc1234def56";

/** Commit `main` points at before the base push. */
export const BASE_SHA = "0f2c9a1b4e7d3f6a8c5b2e9d1f4a7c0b3e6d9f2a";

/** Commit `main` points at after the base push. */
export const PUSHED_SHA = "def5678abc1234def5678abc1234def5678abc12";

/** Number of the first PR the mock harness opens against the smoke repo. */
export const PULL_REQUEST_NUMBER = 1;

/** URL of the first PR the mock harness opens against the smoke repo. */
export const PULL_REQUEST_URL = `https://github.com/${REPO_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`;

const CREATED_AT = "2026-09-03T10:00:00Z";

/** Builds pull request #1 with its head on `branch` in the same repository, not a fork. */
export function pullRequestFixture(branch: string): PullRequestFixture {
  return {
    id: 2_100_000_001,
    node_id: "PR_kwDOIvd0Bs5-AAAB",
    number: PULL_REQUEST_NUMBER,
    state: "open",
    locked: false,
    title: "Fix login redirect",
    user: agentBotFixture,
    body: "Redirects to the page the user asked for after login.\n\nCloses ENG-42.",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    merged_at: null,
    html_url: PULL_REQUEST_URL,
    url: `https://api.github.com/repos/${REPO_FULL_NAME}/pulls/${PULL_REQUEST_NUMBER}`,
    draft: false,
    merged: false,
    head: {
      label: `${OWNER_LOGIN}:${branch}`,
      ref: branch,
      sha: HEAD_SHA,
      user: ownerFixture,
      repo: repositoryFixture,
    },
    base: {
      label: `${OWNER_LOGIN}:main`,
      ref: "main",
      sha: BASE_SHA,
      user: ownerFixture,
      repo: repositoryFixture,
    },
    author_association: "NONE",
  };
}

/** A `pull_request` event payload. */
export function pullRequestEvent(
  action: "opened" | "closed",
  pullRequest: PullRequestFixture,
  sender: GithubAccount,
): Record<string, unknown> {
  return {
    action,
    number: pullRequest.number,
    pull_request: pullRequest,
    repository: repositoryFixture,
    sender,
    installation: installationFixture,
  };
}

/** The PR as GitHub sends it once merged: closed, merged, with a merge time. */
export function mergedPullRequest(pullRequest: PullRequestFixture): PullRequestFixture {
  return {
    ...pullRequest,
    state: "closed",
    merged: true,
    merged_at: "2026-09-03T11:30:00Z",
    updated_at: "2026-09-03T11:30:00Z",
  };
}

/** A completed `check_suite` event for the PR head with the given conclusion. */
export function checkSuiteEvent(
  pullRequest: PullRequestFixture,
  conclusion: "success" | "failure",
): Record<string, unknown> {
  return {
    action: "completed",
    check_suite: {
      id: 31_000_000_001,
      node_id: "CS_kwDOIvd0Bs8AAAAHOGwAAQ",
      head_branch: pullRequest.head.ref,
      head_sha: pullRequest.head.sha,
      status: "completed",
      conclusion,
      url: `https://api.github.com/repos/${REPO_FULL_NAME}/check-suites/31000000001`,
      before: BASE_SHA,
      after: pullRequest.head.sha,
      pull_requests: [
        {
          url: pullRequest.url,
          id: pullRequest.id,
          number: pullRequest.number,
          head: { ref: pullRequest.head.ref, sha: pullRequest.head.sha },
          base: { ref: pullRequest.base.ref, sha: pullRequest.base.sha },
        },
      ],
      app: { id: 15368, slug: "github-actions", name: "GitHub Actions" },
      created_at: CREATED_AT,
      updated_at: "2026-09-03T10:05:00Z",
      latest_check_runs_count: 2,
    },
    repository: repositoryFixture,
    sender: { ...agentBotFixture, login: "github-actions[bot]", id: 41898282 },
    installation: installationFixture,
  };
}

/** A review App the repository installed. */
export const reviewBotFixture: GithubAccount = {
  login: "acme-review[bot]",
  id: 3003,
  node_id: "BOT_kgDOAAALuw",
  type: "Bot",
};

/**
 * GitHub's id per review the smoke submits. Its inline comments carry the same id, which is what
 * joins the webhooks of one review into one event.
 */
export const REVIEW_IDS = {
  changes_requested: 2_500_000_001,
  commented: 2_500_000_002,
  agent: 2_500_000_003,
  approved: 2_500_000_004,
};

/** What a submitted `pull_request_review` needs. The reviewer is a repository member by default. */
export type ReviewFixture = {
  pullRequest: PullRequestFixture;
  state: "approved" | "changes_requested" | "commented";
  body: string;
  reviewer?: GithubAccount;
  reviewId?: number;
};

/** A submitted `pull_request_review` event, by a repository member unless told otherwise. */
export function reviewEvent(review: ReviewFixture): Record<string, unknown> {
  const reviewer = review.reviewer ?? samFixture;
  const reviewId = review.reviewId ?? REVIEW_IDS[review.state];
  return {
    action: "submitted",
    review: {
      id: reviewId,
      node_id: "PRR_kwDOIvd0Bs6VAAAB",
      user: reviewer,
      body: review.body,
      commit_id: review.pullRequest.head.sha,
      submitted_at: "2026-09-03T10:20:00Z",
      state: review.state,
      html_url: `${review.pullRequest.html_url}#pullrequestreview-${reviewId}`,
      author_association: associationOf(reviewer),
    },
    pull_request: review.pullRequest,
    repository: repositoryFixture,
    sender: reviewer,
    installation: installationFixture,
  };
}

/**
 * One inline comment of a review, as `pull_request_review_comment.created`. `reviewId` names the
 * review it belongs to, the commented one by default.
 */
export function reviewCommentEvent(inline: {
  pullRequest: PullRequestFixture;
  comment: { path: string; line: number; body: string };
  reviewer?: GithubAccount;
  reviewId?: number;
}): Record<string, unknown> {
  const reviewer = inline.reviewer ?? samFixture;
  return {
    action: "created",
    comment: {
      id: 2_600_000_001,
      node_id: "PRRC_kwDOIvd0Bs6VAAAB",
      pull_request_review_id: inline.reviewId ?? REVIEW_IDS.commented,
      user: reviewer,
      body: inline.comment.body,
      path: inline.comment.path,
      line: inline.comment.line,
      original_line: inline.comment.line,
      side: "RIGHT",
      commit_id: inline.pullRequest.head.sha,
      created_at: "2026-09-03T10:20:00Z",
      html_url: `${inline.pullRequest.html_url}#discussion_r2600000001`,
      author_association: associationOf(reviewer),
    },
    pull_request: inline.pullRequest,
    repository: repositoryFixture,
    sender: reviewer,
    installation: installationFixture,
  };
}

/** What GitHub reports for the author: a member for a person, nobody for an App. */
function associationOf(account: GithubAccount): string {
  return account.type === "Bot" ? "NONE" : "MEMBER";
}

/** A `push` event to the default branch: someone else merged their work into `main`. */
export function pushToMainEvent(): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    before: BASE_SHA,
    after: PUSHED_SHA,
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare: `https://github.com/${REPO_FULL_NAME}/compare/${BASE_SHA.slice(0, 12)}...${PUSHED_SHA.slice(0, 12)}`,
    commits: [
      {
        id: PUSHED_SHA,
        message: "Bump the analytics client",
        timestamp: "2026-09-03T10:25:00Z",
        author: { name: "Sam", email: "sam@acme.test", username: "sam" },
        added: [],
        removed: [],
        modified: ["package.json"],
      },
    ],
    head_commit: { id: PUSHED_SHA, message: "Bump the analytics client" },
    pusher: { name: "sam", email: "sam@acme.test" },
    repository: repositoryFixture,
    sender: samFixture,
    installation: installationFixture,
  };
}

/** Constant per webhook configuration, as Linear sends it on every delivery. */
export const LINEAR_WEBHOOK_ID = "7d3c0b2a-7c6e-4f8a-9a1b-2c3d4e5f6a7b";

/** The workspace the mock Linear API reports for the app-actor token. */
export const LINEAR_ORG = { id: "org-acme", name: "Acme", urlKey: "acme" };

/** The user the installed app acts as. The mock Linear API returns it as the viewer. */
export const LINEAR_APP_USER = { id: "app-user-artfct", name: "Continuous Dev" };

/** A Linear user as it appears in `creator` and `actor` fields. */
export type LinearUserFixture = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  url: string;
};

export const linearDev: LinearUserFixture = {
  id: "lin-u1",
  name: "Dev",
  email: "dev@acme.test",
  avatarUrl: null,
  url: "https://linear.app/acme/profiles/dev",
};

export const linearPm: LinearUserFixture = {
  id: "lin-u2",
  name: "PM",
  email: "pm@acme.test",
  avatarUrl: null,
  url: "https://linear.app/acme/profiles/pm",
};

/** The team every smoke issue belongs to. */
export const LINEAR_TEAM = { id: "team-1", key: "ENG", name: "Engineering" };

/** The workflow states of the team, as the mock Linear API answers `teamStates`. */
export const LINEAR_TEAM_STATES = [
  { id: "state-todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "state-progress", name: "In Progress", type: "started", position: 1 },
  { id: "state-approved", name: "Approved", type: "started", position: 2 },
  { id: "state-done", name: "Done", type: "completed", position: 3 },
];

/** A Linear issue as it appears inside `agentSession.issue`. */
export type LinearIssueFixture = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamId: string;
  team: typeof LINEAR_TEAM;
  priority: number;
};

/** An issue whose id is unique to this run. `n` distinguishes issues within the run. */
export function linearIssue(
  n: number,
  identifier: string,
  title: string,
  description: string,
): LinearIssueFixture {
  return {
    id: `iss-${n}-${RUN_ID}`,
    identifier,
    title,
    description,
    url: `https://linear.app/acme/issue/${identifier}`,
    teamId: LINEAR_TEAM.id,
    team: LINEAR_TEAM,
    priority: 2,
  };
}

/** A session id unique to this run, numbered by `index`. */
export function linearSessionId(index: number): string {
  return `sess-${index}-${RUN_ID}`;
}

/** Fields shared by both agent session actions. */
function agentSession(
  sessionId: string,
  creator: LinearUserFixture,
  issue: LinearIssueFixture,
  comment: { id: string; body: string } | null,
): Record<string, unknown> {
  return {
    id: sessionId,
    createdAt: "2026-09-03T09:59:00.000Z",
    updatedAt: "2026-09-03T09:59:00.000Z",
    archivedAt: null,
    status: "active",
    startedAt: "2026-09-03T09:59:00.000Z",
    endedAt: null,
    type: "commentThread",
    summary: null,
    sourceMetadata: null,
    creator,
    issue,
    comment,
    appUser: LINEAR_APP_USER,
    organization: LINEAR_ORG,
  };
}

/** The envelope fields Linear puts around every webhook. */
function linearEnvelope(): Record<string, unknown> {
  return {
    createdAt: new Date().toISOString(),
    organizationId: LINEAR_ORG.id,
    oauthClientId: "oauth-client-artfct",
    appUserId: LINEAR_APP_USER.id,
    webhookTimestamp: Date.now(),
    webhookId: LINEAR_WEBHOOK_ID,
  };
}

/** An `AgentSessionEvent` `created` payload: a person delegated an issue to the agent. */
export function agentSessionCreated(options: {
  sessionId: string;
  creator: LinearUserFixture;
  issue: LinearIssueFixture;
  comment?: string;
}): Record<string, unknown> {
  const comment = options.comment
    ? { id: `cmt-${options.sessionId}`, body: options.comment }
    : null;
  return {
    type: "AgentSessionEvent",
    action: "created",
    ...linearEnvelope(),
    agentSession: agentSession(options.sessionId, options.creator, options.issue, comment),
    agentActivity: null,
    guidance: null,
    promptContext: null,
  };
}

/** An `AgentSessionEvent` `prompted` payload: a person wrote on the session thread. */
export function agentSessionPrompted(options: {
  sessionId: string;
  creator: LinearUserFixture;
  issue: LinearIssueFixture;
  body: string;
}): Record<string, unknown> {
  const activityId = `act-${crypto.randomUUID()}`;
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    ...linearEnvelope(),
    agentSession: agentSession(options.sessionId, options.creator, options.issue, null),
    agentActivity: {
      id: activityId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentSessionId: options.sessionId,
      sourceCommentId: `cmt-${activityId}`,
      content: { type: "prompt", body: options.body },
      signal: null,
    },
    guidance: null,
    promptContext: null,
  };
}

/** A team state the smoke moves an issue into. Not in `LINEAR_TEAM_STATES`: the payload carries it. */
export const LINEAR_CANCELED_STATE = { id: "state-canceled", name: "Canceled", type: "canceled" };

/** An `Issue` `update` payload: a person moved the issue from one state into another. */
export function issueStateChanged(options: {
  issue: LinearIssueFixture;
  from: { id: string };
  to: { id: string; name: string; type: string };
  actor: LinearUserFixture;
}): Record<string, unknown> {
  const { issue, from, to, actor } = options;
  return {
    type: "Issue",
    action: "update",
    ...linearEnvelope(),
    data: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      priority: issue.priority,
      stateId: to.id,
      state: { id: to.id, name: to.name, type: to.type, color: "#95a2b3" },
      teamId: issue.teamId,
      team: { id: issue.team.id, key: issue.team.key, name: issue.team.name },
      assignee: null,
      updatedAt: new Date().toISOString(),
    },
    updatedFrom: { stateId: from.id, updatedAt: "2026-09-03T09:59:00.000Z" },
    actor,
    url: issue.url,
  };
}

/** Workspace and app ids the Slack envelope carries. */
export const SLACK_TEAM_ID = "T0ACME01";
export const SLACK_APP_ID = "A0AGENT01";
export const SLACK_BOT_USER_ID = "UBOT";

/** An `app_mention` event: a person mentioned the bot at the top level of a channel. */
export function slackMention(options: {
  channel: string;
  ts: string;
  user: string;
  text: string;
}): Record<string, unknown> {
  return {
    type: "app_mention",
    client_msg_id: crypto.randomUUID(),
    user: options.user,
    text: options.text,
    ts: options.ts,
    channel: options.channel,
    event_ts: options.ts,
    team: SLACK_TEAM_ID,
    blocks: [
      {
        type: "rich_text",
        block_id: "b1",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: options.text }] }],
      },
    ],
  };
}

/** A `message` event: a person replied inside a thread without mentioning the bot. */
export function slackThreadReply(options: {
  channel: string;
  threadTs: string;
  user: string;
  text: string;
}): Record<string, unknown> {
  const ts = `${Math.floor(Date.now() / 1000)}.000200`;
  return {
    type: "message",
    client_msg_id: crypto.randomUUID(),
    user: options.user,
    text: options.text,
    ts,
    thread_ts: options.threadTs,
    channel: options.channel,
    channel_type: "channel",
    event_ts: ts,
    team: SLACK_TEAM_ID,
  };
}

/** A `reaction_added` event on a message. */
export function slackReaction(options: {
  channel: string;
  ts: string;
  user: string;
  reaction: string;
}): Record<string, unknown> {
  return {
    type: "reaction_added",
    user: options.user,
    reaction: options.reaction,
    item: { type: "message", channel: options.channel, ts: options.ts },
    item_user: SLACK_BOT_USER_ID,
    event_ts: `${Math.floor(Date.now() / 1000)}.000100`,
  };
}
