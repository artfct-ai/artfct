import { Hono } from "hono";
import type { Context } from "hono";
import { slackInbound } from "@artfct-ai/adapters/chat/slack/inbound";
import { slackVendorEvent } from "@artfct-ai/adapters/chat/slack/vendor-event";
import { verifySlackWebhook } from "@artfct-ai/adapters/chat/slack/webhook";
import type { JsonValue } from "@artfct-ai/contracts/types";
import { clientsFromEnv, type ChannelClients } from "../clients";
import type { HonoEnv } from "../env";
import { parseJsonBody, secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/** Slack retries an event when the reply takes over 3 s. This header tells it not to. */
const NO_RETRY = { "x-slack-no-retry": "1" };

/** The one reaction that reaches a workflow, as a short reply. Every other reaction is dropped here. */
const REPLY_REACTION = "white_check_mark";

type SlackEnvelope = { type?: string; challenge?: string; event_id?: string };

/** Slack Events API. The reply goes out before normalization so Slack never retries. */
export const slackRoutes = new Hono<HonoEnv>();

slackRoutes.post("/webhooks/slack", async (ctx) => {
  const secret = ctx.env.SLACK_SIGNING_SECRET;
  if (!secret) return secretNotConfigured(ctx, "SLACK_SIGNING_SECRET");
  const body = await ctx.req.text();
  if (!(await verifySlackWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);

  const payload = parseJsonBody(body);
  const envelope = payload as SlackEnvelope | null;
  if (!envelope) return ctx.text("malformed body", 400);
  if (envelope.type === "url_verification") return ctx.json({ challenge: envelope.challenge });
  if (envelope.type !== "event_callback") return ctx.json({ ignored: envelope.type });
  if (ctx.req.header("x-slack-retry-num")) return ctx.json({ ignored: "retry" }, 200, NO_RETRY);

  const clients = ctx.get("clients") ?? clientsFromEnv(ctx.env);
  ctx.executionCtx.waitUntil(handleCallback(ctx, clients, payload, envelope.event_id));
  return ctx.json({ ok: true }, 200, NO_RETRY);
});

/**
 * Normalize and deliver after the reply has gone out, then hand the callback to the Slack
 * pass-through. Errors go to the log.
 */
async function handleCallback(
  ctx: Context<HonoEnv>,
  clients: ChannelClients,
  callback: JsonValue,
  eventId: string | undefined,
): Promise<void> {
  try {
    const rpc = ctx.env.ORCHESTRATOR;
    const normalized = await slackInbound(callback, {
      resolveActor: (user) => rpc.resolveActor({ source: "chat", user }),
      chat: clients.chat,
      reaction: REPLY_REACTION,
    });
    tagSpan(ctx, {
      "artfct.vendor": "slack",
      "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
    });
    if (!("ignore" in normalized)) await rpc.deliver(normalized.event);
    const passed = slackVendorEvent(callback);
    if ("event" in passed) await rpc.deliverVendorEvent(passed.event);
  } catch (error) {
    console.error(`slack ${eventId}: ${String(error)}`);
  }
}
