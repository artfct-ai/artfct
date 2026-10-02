import type { SlackEventCallback } from "@artfct-ai/adapters/chat/slack/inbound";
import type { NotionWebhook } from "@artfct-ai/adapters/docs/notion/inbound";
import type {
  AgentSessionPayload,
  CommentPayload,
} from "@artfct-ai/adapters/tracker/linear/inbound-payloads";

/** An orchestrator branch. The task id in the name resolves to workflow `wf_abcdefghij`. */
export const ORCHESTRATOR_BRANCH = "artfct/wf_abcdefghij-1-fix-login";

const GITHUB_REPO = {
  id: 501,
  node_id: "R_kgDOAAAB9Q",
  name: "app",
  full_name: "acme/app",
  private: false,
  owner: { login: "acme", id: 77, type: "Organization" },
  html_url: "https://github.com/acme/app",
  default_branch: "main",
};

/** A `pull_request` webhook as the GitHub App receives it. Fields ingress ignores are kept. */
export function githubPullRequest(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    number: 7,
    pull_request: {
      id: 9001,
      node_id: "PR_kwDOAAAB9c5Dh3Wq",
      url: "https://api.github.com/repos/acme/app/pulls/7",
      html_url: "https://github.com/acme/app/pull/7",
      number: 7,
      state: "open",
      locked: false,
      draft: false,
      title: "Fix login",
      body: "Closes ENG-1",
      user: { login: "artfct[bot]", id: 4242, type: "Bot" },
      merged: false,
      mergeable: true,
      head: {
        label: `acme:${ORCHESTRATOR_BRANCH}`,
        ref: ORCHESTRATOR_BRANCH,
        sha: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
        repo: GITHUB_REPO,
      },
      base: {
        label: "acme:main",
        ref: "main",
        sha: "9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a",
        repo: GITHUB_REPO,
      },
      ...overrides,
    },
    repository: GITHUB_REPO,
    sender: { login: "sam", id: 12, type: "User" },
    installation: { id: 31337, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMzEzMzc=" },
  };
}

/** An `AgentSessionEvent` webhook as Linear sends it when an issue is delegated. */
export function linearSessionCreated(): AgentSessionPayload {
  return {
    type: "AgentSessionEvent",
    action: "created",
    webhookId: "wh_9f2c",
    webhookTimestamp: Date.now(),
    organizationId: "org_acme",
    agentSession: {
      id: "sess1",
      creator: { id: "u1", email: "dev@acme.test", name: "Dev" },
      issue: {
        id: "iss1",
        identifier: "ENG-1",
        title: "Fix login",
        description: "Users are logged out after refresh. See https://github.com/acme/app",
        url: "https://linear.app/acme/issue/ENG-1/fix-login",
        team: { id: "t1", key: "ENG" },
      },
      comment: { id: "cmt1", body: "@agent please take this" },
    },
    agentActivity: null,
    guidance: "Keep the change small.",
    promptContext: null,
  };
}

/** The Linear user the installed app writes as in these fixtures. */
export const LINEAR_APP_USER_ID = "app1";

/** A `Comment` webhook as Linear sends it for a comment inside a document. */
export function linearDocumentComment(userId: string, body: string): CommentPayload {
  return {
    type: "Comment",
    action: "create",
    webhookId: "wh_9f2c",
    webhookTimestamp: Date.now(),
    organizationId: "org_acme",
    data: { id: "cmt2", body, documentContentId: "content1", userId },
  };
}

/** An `app_mention` event callback as the Slack Events API sends it. */
export function slackMention(text: string): SlackEventCallback & Record<string, unknown> {
  return {
    token: "verification-token-legacy",
    team_id: "T1",
    api_app_id: "A1",
    type: "event_callback",
    event_id: "Ev1",
    event_time: 1756893600,
    event_context: "1-app_mention-T1-C1",
    is_ext_shared_channel: false,
    authorizations: [{ user_id: "UBOT" }],
    event: {
      type: "app_mention",
      user: "U1",
      text,
      ts: "1756893600.000100",
      channel: "C1",
    },
  };
}

/** A `message` event callback for a reply inside the thread `slackMention` starts. */
export function slackThreadReply(text: string): SlackEventCallback & Record<string, unknown> {
  return {
    ...slackMention(text),
    event_context: "1-message-T1-C1",
    event: {
      type: "message",
      user: "U1",
      text,
      ts: "1756893700.000100",
      thread_ts: "1756893600.000100",
      channel: "C1",
    },
  };
}

/** A `member_joined_channel` event callback as Slack sends it when a member joins a channel. */
export function slackMemberJoined(user: string): SlackEventCallback & Record<string, unknown> {
  return {
    ...slackMention(""),
    event_context: "1-member_joined_channel-T1-C1",
    event: { type: "member_joined_channel", user, channel: "C1" },
  };
}

/** The page the Notion fixture comments on, as Notion writes an id, with dashes. */
export const NOTION_PAGE_ID = "1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b";

/** A `comment.created` webhook as Notion sends it. The comment body is not in the payload. */
export function notionCommentCreated(): NotionWebhook & Record<string, unknown> {
  return {
    id: "evt1",
    timestamp: "2026-09-03T10:00:00.000Z",
    workspace_id: "ws1",
    workspace_name: "Acme",
    subscription_id: "sub1",
    integration_id: "int1",
    attempt_number: 1,
    authors: [{ id: "n1", type: "person" }],
    entity: { id: "cmt1", type: "comment" },
    type: "comment.created",
    data: { page_id: NOTION_PAGE_ID, parent: { id: NOTION_PAGE_ID, type: "page" } },
  };
}
