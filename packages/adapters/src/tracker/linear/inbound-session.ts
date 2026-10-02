import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { ExternalUser } from "@artfct-ai/contracts/types";
import { classifyPrompt } from "../../classify";
import { extractLinks } from "../../links";
import { linearEventId } from "./inbound-event-id";
import type { AgentSessionPayload } from "./inbound-payloads";
import type { TrackerInbound, TrackerInboundContext } from "../types";

type SessionBase = Pick<InboundEvent, "id" | "actor" | "bindings" | "reply_to">;

/**
 * Agent session events. `created` starts a workflow and `prompted` carries a reply. A session
 * the agent opened itself has no creator, so it carries no actor. An event from a user who is
 * not authorized is ignored.
 */
export async function linearAgentSessionEvent(
  payload: AgentSessionPayload,
  context: TrackerInboundContext,
): Promise<TrackerInbound> {
  const session = payload.agentSession;
  const issue = session.issue;
  const teamId = issue?.team?.id ?? null;
  const author = eventAuthor(payload);
  const actor = author ? await context.resolveActor(author) : null;
  if (author && !actor) return { ignore: "session event from a user who is not authorized" };
  const bindings: Binding[] = [{ source: "tracker_session", external_id: session.id }];
  if (issue?.id) bindings.push({ source: "tracker_issue", external_id: issue.id });

  const base: SessionBase = {
    id: await linearEventId(payload, context.deliveryId),
    actor,
    bindings,
    reply_to: {
      source: "tracker",
      session_id: session.id,
      issue_id: issue?.id ?? "",
      team_id: teamId ?? undefined,
    },
  };
  if (payload.action === "created") return sessionCreated(payload, base);
  return sessionPrompted(payload, base);
}

/**
 * Who this event is from: whoever wrote the prompt, or whoever opened the session. Null on a
 * session the agent opened itself.
 */
function eventAuthor(payload: AgentSessionPayload): ExternalUser | null {
  const session = payload.agentSession;
  const opener = session.creator ?? userById(session.creatorId);
  if (payload.action !== "prompted") return opener;
  const activity = payload.agentActivity;
  const comment = activity?.sourceComment;
  return (
    activity?.user ??
    userById(activity?.userId) ??
    comment?.user ??
    userById(comment?.userId) ??
    opener
  );
}

function userById(userId: string | null | undefined): ExternalUser | null {
  return userId ? { id: userId } : null;
}

/** The issue text, the delegating comment, and any prompt context become the start prompt. */
function sessionCreated(payload: AgentSessionPayload, base: SessionBase): TrackerInbound {
  const session = payload.agentSession;
  const issue = session.issue;
  const text = [issue?.description ?? "", session.comment?.body ?? "", payload.promptContext ?? ""]
    .filter(Boolean)
    .join("\n\n");
  const guidance = payload.guidance ? `\n\nGuidance:\n${payload.guidance}` : "";
  return {
    event: {
      ...base,
      kind: "start",
      links: extractLinks(`${text}\n${issue?.url ?? ""}`),
      text: `${text}${guidance}`,
      title: issue?.title ? `${issue.identifier ?? ""} ${issue.title}`.trim() : "Linear request",
    },
  };
}

function sessionPrompted(payload: AgentSessionPayload, base: SessionBase): TrackerInbound {
  const body = payload.agentActivity?.content?.body ?? "";
  return {
    event: { ...base, kind: classifyPrompt(body), links: extractLinks(body), text: body },
  };
}
