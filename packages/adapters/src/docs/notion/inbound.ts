import type { Actor } from "@artfct-ai/contracts/inbound";
import { extractLinks } from "../../links";
import { notionPageId } from "./page-id";
import type { DocsInbound, DocsInboundContext } from "../types";

/** Notion webhook envelope. Comments arrive as ids only. */
export type NotionWebhook = {
  id: string;
  type: string;
  entity?: { id: string; type: string };
  data?: { parent?: { id: string; type: string }; page_id?: string };
  authors?: Array<{ id: string; type: string }>;
};

/** A comment on a page is feedback on the artifact bound to that page. */
export async function notionInbound(
  payload: NotionWebhook,
  context: DocsInboundContext,
): Promise<DocsInbound> {
  if (payload.type !== "comment.created") return { ignore: payload.type };
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
      bindings: [{ source: "docs_page", external_id: pageId }],
      links: extractLinks(comment.text),
      text: comment.text,
      reply_to: { source: "docs", page_id: pageUrlId },
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
  context: DocsInboundContext,
  author: { id: string; email: string | null } | null,
): Promise<Actor | null> {
  if (!author) return null;
  const email = author.email ?? (await context.documents.userEmail(author.id).catch(() => null));
  return context.resolveActor({ id: author.id, email });
}
