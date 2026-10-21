import { isNotionConversationalEvent } from "./conversational-events";
import { notionVendorEventName } from "./vendor-event-name";
import { z } from "zod";
import type { Actor } from "@artfct-ai/contracts/inbound";
import { extractLinks } from "../../links";
import { notionPageId } from "./page-id";
import type { DocumentsInbound, DocumentsInboundContext } from "../types";

const notionWebhookSchema = z.object({
  id: z.string(),
  type: z.string().min(1),
  entity: z.object({ id: z.string(), type: z.string() }).nullish(),
  data: z
    .object({
      parent: z.object({ id: z.string(), type: z.string() }).nullish(),
      page_id: z.string().nullish(),
    })
    .nullish(),
  authors: z.array(z.object({ id: z.string(), type: z.string() })).nullish(),
});

/** Notion webhook envelope. Comments arrive as ids only. */
export type NotionWebhook = z.infer<typeof notionWebhookSchema>;

/**
 * A comment on a page is feedback on the artifact bound to that page. Every other event is
 * ignored, and so is a payload of another shape.
 */
export async function notionInbound(
  body: unknown,
  context: DocumentsInboundContext,
): Promise<DocumentsInbound> {
  const parsed = notionWebhookSchema.safeParse(body);
  if (!parsed.success) return { ignore: "malformed notion webhook" };
  const payload = parsed.data;
  if (!isNotionConversationalEvent(notionVendorEventName(payload.type))) {
    return { ignore: payload.type };
  }
  const pageUrlId = pageIdOf(payload);
  const pageId = pageUrlId ? notionPageId(pageUrlId) : null;
  if (!pageUrlId || !pageId) return { ignore: "comment without page" };
  const commentId = payload.entity?.id;
  if (!commentId) return { ignore: "comment without id" };

  const comment = await context.documents.fetchComment(commentId);
  if (!comment) return { ignore: "comment Notion no longer holds" };
  const actor = await resolveAuthor(context, comment.author);
  if (!actor) return { ignore: "comment author is not authorized" };
  return {
    event: {
      id: `notion:${payload.id}`,
      kind: "feedback",
      actor,
      bindings: [{ source: "documents_page", external_id: pageId }],
      links: extractLinks(comment.text),
      text: comment.text,
      reply_to: { source: "documents", page_id: pageUrlId },
      page: { page_id: pageId, comment_id: commentId },
    },
  };
}

function pageIdOf(payload: NotionWebhook): string | null {
  if (payload.data?.parent?.type === "page") return payload.data.parent.id;
  return payload.data?.page_id ?? null;
}

/** The comment author, with the email the host holds when the comment itself carries none. */
async function resolveAuthor(
  context: DocumentsInboundContext,
  author: { id: string; email: string | null } | null,
): Promise<Actor | null> {
  if (!author) return null;
  const email = author.email ?? (await context.documents.userEmail(author.id).catch(() => null));
  return context.resolveActor({ id: author.id, email: email?.toLowerCase() ?? null });
}
