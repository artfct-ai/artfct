import { linearCommentEvent } from "./inbound-comment";
import { linearIssueEvent } from "./inbound-issue";
import {
  agentSessionPayloadSchema,
  commentPayloadSchema,
  issuePayloadSchema,
  linearWebhookSchema,
} from "./inbound-payloads";
import { linearAgentSessionEvent } from "./inbound-session";
import { isLinearConversationalEvent } from "./conversational-events";
import { linearVendorEventName } from "./vendor-event-name";
import type { TrackerInbound, TrackerInboundContext } from "../types";

/**
 * Map a Linear webhook to an inbound event. A webhook of another workspace is ignored, since
 * Linear signs for every workspace that authorized the app. Unhandled type and action pairs are
 * ignored by name, and so is a handled pair whose payload lacks a field the mapper reads.
 */
export async function linearInbound(
  payload: unknown,
  context: TrackerInboundContext,
): Promise<TrackerInbound> {
  const webhook = linearWebhookSchema.safeParse(payload);
  if (!webhook.success) return { ignore: "malformed linear webhook" };
  const { type, action, organizationId } = webhook.data;
  if (organizationId !== context.workspaceId) return { ignore: "another workspace" };
  const malformed: TrackerInbound = { ignore: `malformed ${type}/${action}` };
  if (type === "Issue" && action === "update") {
    const issue = issuePayloadSchema.safeParse(payload);
    return issue.success ? linearIssueEvent(issue.data, context) : malformed;
  }
  if (!isLinearConversationalEvent(linearVendorEventName(type, action))) {
    return { ignore: `${type}/${action}` };
  }
  if (type === "AgentSessionEvent") {
    const session = agentSessionPayloadSchema.safeParse(payload);
    return session.success ? linearAgentSessionEvent(session.data, context) : malformed;
  }
  if (type === "Comment" && action === "create") {
    const comment = commentPayloadSchema.safeParse(payload);
    return comment.success ? linearCommentEvent(comment.data, context) : malformed;
  }
  return { ignore: `${type}/${action}` };
}
