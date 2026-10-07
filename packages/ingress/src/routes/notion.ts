import { Hono } from "hono";
import { notionInbound, type NotionWebhook } from "@artfct-ai/adapters/documents/notion/inbound";
import {
  notionVerificationToken,
  verifyNotionWebhook,
} from "@artfct-ai/adapters/documents/notion/webhook";
import { clientsFromEnv } from "../clients";
import type { HonoEnv } from "../env";
import { parseJsonBody, secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/**
 * Notion webhooks. The subscription handshake is the one unsigned request, accepted only while
 * the verification token is unset. A comment arrives as an id, so its body is fetched with
 * `NOTION_TOKEN`.
 */
export const notionRoutes = new Hono<HonoEnv>();

notionRoutes.post("/webhooks/notion", async (ctx) => {
  const body = await ctx.req.text();
  const secret = ctx.env.NOTION_VERIFICATION_TOKEN;
  const handshakeToken = notionVerificationToken(body);
  if (handshakeToken && secret) {
    console.error("notion handshake refused. NOTION_VERIFICATION_TOKEN is already set.");
    return ctx.text("verification token already set", 409);
  }
  if (handshakeToken) {
    console.log(
      `notion verification token received. Set NOTION_VERIFICATION_TOKEN to: ${handshakeToken}`,
    );
    return ctx.json({ ok: true });
  }
  if (!secret) return secretNotConfigured(ctx, "NOTION_VERIFICATION_TOKEN");
  if (!(await verifyNotionWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);

  const payload = parseJsonBody(body) as NotionWebhook | null;
  if (!payload) return ctx.text("malformed body", 400);
  if (payload.type !== "comment.created") return ctx.json({ ignored: payload.type });
  const { documents } = ctx.get("clients") ?? clientsFromEnv(ctx.env);
  if (!documents) {
    console.error("NOTION_TOKEN is not set. Comment bodies cannot be fetched.");
    return ctx.text("NOTION_TOKEN not configured", 503);
  }

  const rpc = ctx.env.ORCHESTRATOR;
  const normalized = await notionInbound(payload, {
    resolveActor: (user) => rpc.resolveActor({ source: "documents", user }),
    documents: documents,
  });
  tagSpan(ctx, {
    "artfct.vendor": "notion",
    "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
  });
  if ("ignore" in normalized) return ctx.json({ ignored: normalized.ignore });
  return ctx.json(await rpc.deliver(normalized.event));
});
