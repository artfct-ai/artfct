import type { ExternalUser } from "@artfct-ai/contracts/types";
import { linearEventId } from "./inbound-event-id";
import type { CommentPayload } from "./inbound-payloads";
import type { TrackerInbound, TrackerInboundContext } from "../types";

/**
 * A comment a person wrote inside a document is feedback on the page artifact bound by the
 * document content id. Comments on issues are ignored, since agent sessions carry those.
 */
export async function linearCommentEvent(
  payload: CommentPayload,
  context: TrackerInboundContext,
): Promise<TrackerInbound> {
  const contentId = documentContentId(payload);
  if (!contentId) return { ignore: "comment outside a document. sessions carry prompts." };
  const author = commentAuthor(payload);
  const actor = author ? await context.resolveActor(author) : null;
  if (!actor) return { ignore: "comment no person wrote" };
  return {
    event: {
      id: await linearEventId(payload, context.deliveryId),
      kind: "feedback",
      actor,
      bindings: [{ source: "documents_page", external_id: contentId }],
      links: [],
      text: payload.data.body ?? "",
      page: { page_id: contentId, comment_id: payload.data.id },
    },
  };
}

/** The user who signed the comment, expanded or as an id. Null for a comment an integration wrote. */
function commentAuthor(payload: CommentPayload): ExternalUser | null {
  const { user, userId } = payload.data;
  return user ?? (userId ? { id: userId } : null);
}

/** The document the comment is in. Null for a comment on an issue or a project update. */
function documentContentId(payload: CommentPayload): string | null {
  const issueId = payload.data.issueId ?? payload.data.issue?.id;
  if (issueId) return null;
  return payload.data.documentContentId ?? null;
}
