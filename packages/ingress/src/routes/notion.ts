import { Hono, type Context } from "hono";
import type { JsonValue } from "@artfct-ai/contracts/types";
import { isNotionConversationalEvent } from "@artfct-ai/adapters/documents/notion/conversational-events";
import { notionInbound } from "@artfct-ai/adapters/documents/notion/inbound";
import { notionVendorEvent } from "@artfct-ai/adapters/documents/notion/vendor-event";
import { notionVendorEventName } from "@artfct-ai/adapters/documents/notion/vendor-event-name";
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
 * `NOTION_TOKEN`. Every verified delivery also goes to the Notion pass-through.
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

  const payload = parseJsonBody(body);
  if (!payload) return ctx.text("malformed body", 400);
  const conversational = await deliverNotionComment(ctx, payload);
  if (conversational instanceof Response) return conversational;
  const passed = notionVendorEvent(payload);
  const vendorEvent =
    "drop" in passed
      ? { dropped: passed.drop }
      : await ctx.env.ORCHESTRATOR.deliverVendorEvent(passed.event);
  return ctx.json({ conversational, vendor_event: vendorEvent });
});

/**
 * Deliver a comment, the one conversational event, or say why the delivery was ignored. A
 * comment without `NOTION_TOKEN` answers 503, so Notion delivers it again.
 */
async function deliverNotionComment(ctx: Context<HonoEnv>, payload: JsonValue) {
  const type = typeof payload === "object" && !Array.isArray(payload) ? payload?.type : null;
  if (typeof type !== "string") return { ignored: "malformed notion webhook" };
  if (!isNotionConversationalEvent(notionVendorEventName(type))) return { ignored: type };
  const { documents } = ctx.get("clients") ?? clientsFromEnv(ctx.env);
  if (!documents) {
    console.error("NOTION_TOKEN is not set. Comment bodies cannot be fetched.");
    return ctx.text("NOTION_TOKEN not configured", 503);
  }

  const rpc = ctx.env.ORCHESTRATOR;
  const normalized = await notionInbound(payload, {
    resolveActor: (user) => rpc.resolveActor({ source: "documents", user }),
    documents,
  });
  tagSpan(ctx, {
    "artfct.vendor": "notion",
    "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
  });
  if ("ignore" in normalized) return { ignored: normalized.ignore };
  return rpc.deliver(normalized.event);
}
