import type { ExternalUser } from "@artfct-ai/contracts/types";

/** Agent session webhook. `created` delegates an issue. `prompted` is a follow-up message. */
export type AgentSessionPayload = {
  type: "AgentSessionEvent";
  action: "created" | "prompted";
  webhookId?: string;
  webhookTimestamp?: number;
  organizationId?: string;
  agentSession: {
    id: string;
    creator?: ExternalUser | null;
    creatorId?: string | null;
    issue?: {
      id: string;
      identifier?: string;
      title?: string;
      description?: string | null;
      url?: string;
      team?: { id: string; key?: string } | null;
    } | null;
    comment?: { id: string; body?: string } | null;
  };
  agentActivity?: {
    id?: string;
    content?: { type?: string; body?: string };
    user?: ExternalUser | null;
    userId?: string | null;
    sourceCommentId?: string;
    sourceComment?: {
      id: string;
      body?: string;
      user?: ExternalUser | null;
      userId?: string | null;
    } | null;
  } | null;
  guidance?: string | null;
  promptContext?: string | null;
};

/** Issue comment webhook. */
export type CommentPayload = {
  type: "Comment";
  action: "create" | "update" | "remove";
  webhookId?: string;
  webhookTimestamp?: number;
  organizationId?: string;
  data: {
    id: string;
    body: string;
    issueId?: string;
    issue?: { id: string; team?: { id: string } };
    /** Set on a comment inside a document, in place of the issue. */
    documentContentId?: string | null;
    user?: ExternalUser | null;
    userId?: string;
  };
};

/** Issue webhook. Only state changes matter here. */
export type IssuePayload = {
  type: "Issue";
  action: "create" | "update" | "remove";
  webhookId?: string;
  organizationId?: string;
  data: {
    id: string;
    title?: string;
    state?: { id: string; name: string; type: string };
    team?: { id: string };
    assignee?: ExternalUser | null;
  };
  updatedFrom?: { stateId?: string };
  actor?: ExternalUser | null;
};

/** Any Linear webhook. Unknown types fall through to the catch-all member. */
export type LinearPayload =
  | AgentSessionPayload
  | CommentPayload
  | IssuePayload
  | { type: string; action: string; organizationId?: string };
