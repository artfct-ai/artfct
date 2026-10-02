import { linearCommentEvent } from "./inbound-comment";
import { linearIssueEvent } from "./inbound-issue";
import type {
  AgentSessionPayload,
  CommentPayload,
  IssuePayload,
  LinearPayload,
} from "./inbound-payloads";
import { linearAgentSessionEvent } from "./inbound-session";
import type { TrackerInbound, TrackerInboundContext } from "../types";

/**
 * Map a Linear webhook to an inbound event. A webhook of another workspace is ignored, since
 * Linear signs for every workspace that authorized the app. Unhandled type and action pairs are
 * ignored by name.
 */
export async function linearInbound(
  payload: LinearPayload,
  context: TrackerInboundContext,
): Promise<TrackerInbound> {
  if (payload.organizationId !== context.workspaceId) return { ignore: "another workspace" };
  if (payload.type === "AgentSessionEvent") {
    return linearAgentSessionEvent(payload as AgentSessionPayload, context);
  }
  if (payload.type === "Comment" && payload.action === "create") {
    return linearCommentEvent(payload as CommentPayload, context);
  }
  if (payload.type === "Issue" && payload.action === "update") {
    return linearIssueEvent(payload as IssuePayload, context);
  }
  return { ignore: `${payload.type}/${payload.action}` };
}
