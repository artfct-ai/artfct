import { z } from "zod";

const externalUserSchema = z.object({
  id: z.string(),
  email: z.string().nullish(),
  name: z.string().nullish(),
});

/**
 * The fields every Linear webhook carries. `webhookId` and `webhookTimestamp` tell two webhooks
 * apart when the delivery id is missing.
 */
const webhookFields = {
  webhookId: z.string().nullish(),
  webhookTimestamp: z.number().nullish(),
  organizationId: z.string().nullish(),
};

/** Any Linear webhook. The mapper picks the schema of its type and action from these. */
export const linearWebhookSchema = z.object({
  type: z.string(),
  action: z.string(),
  ...webhookFields,
});

/** Agent session webhook. `created` delegates an issue. `prompted` is a follow-up message. */
export const agentSessionPayloadSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: z.enum(["created", "prompted"]),
  ...webhookFields,
  agentSession: z.object({
    id: z.string(),
    creator: externalUserSchema.nullish(),
    creatorId: z.string().nullish(),
    issue: z
      .object({
        id: z.string(),
        identifier: z.string().nullish(),
        title: z.string().nullish(),
        description: z.string().nullish(),
        url: z.string().nullish(),
        team: z.object({ id: z.string(), key: z.string().nullish() }).nullish(),
      })
      .nullish(),
    comment: z.object({ id: z.string(), body: z.string().nullish() }).nullish(),
  }),
  agentActivity: z
    .object({
      id: z.string().nullish(),
      content: z.object({ type: z.string().nullish(), body: z.string().nullish() }).nullish(),
      /** Set when the activity asks something of the agent beyond its text. `stop` is the Stop button. */
      signal: z.string().nullish(),
      user: externalUserSchema.nullish(),
      userId: z.string().nullish(),
      sourceCommentId: z.string().nullish(),
      sourceComment: z
        .object({
          id: z.string(),
          body: z.string().nullish(),
          user: externalUserSchema.nullish(),
          userId: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  guidance: z.string().nullish(),
  promptContext: z.string().nullish(),
});

/** Issue comment webhook. */
export const commentPayloadSchema = z.object({
  type: z.literal("Comment"),
  action: z.literal("create"),
  ...webhookFields,
  data: z.object({
    id: z.string(),
    body: z.string().nullish(),
    issueId: z.string().nullish(),
    issue: z.object({ id: z.string(), team: z.object({ id: z.string() }).nullish() }).nullish(),
    /** Set on a comment inside a document, in place of the issue. */
    documentContentId: z.string().nullish(),
    user: externalUserSchema.nullish(),
    userId: z.string().nullish(),
  }),
});

/** Issue webhook. Only state changes matter here. */
export const issuePayloadSchema = z.object({
  type: z.literal("Issue"),
  action: z.literal("update"),
  ...webhookFields,
  data: z.object({
    id: z.string(),
    title: z.string().nullish(),
    state: z.object({ id: z.string(), name: z.string(), type: z.string() }).nullish(),
    team: z.object({ id: z.string() }).nullish(),
    assignee: externalUserSchema.nullish(),
  }),
  updatedFrom: z.object({ stateId: z.string().nullish() }).nullish(),
  actor: externalUserSchema.nullish(),
});

/** An agent session webhook the schema accepted. */
export type AgentSessionPayload = z.infer<typeof agentSessionPayloadSchema>;

/** A comment webhook the schema accepted. */
export type CommentPayload = z.infer<typeof commentPayloadSchema>;

/** An issue update webhook the schema accepted. */
export type IssuePayload = z.infer<typeof issuePayloadSchema>;
