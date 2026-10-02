import { Hono } from "hono";
import type { Context } from "hono";
import {
  appJoinedChannel,
  slackInbound,
  type SlackEventCallback,
} from "@artfct-ai/adapters/chat/slack/inbound";
import { verifySlackWebhook } from "@artfct-ai/adapters/chat/slack/webhook";
import { clientsFromEnv, type ChannelClients } from "../clients";
import type { HonoEnv } from "../env";
import { GREETING } from "../slack-greeting";
import { parseJsonBody, secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/** Slack retries an event when the reply takes over 3 s. This header tells it not to. */
const NO_RETRY = { "x-slack-no-retry": "1" };

/** The one reaction that reaches a workflow, as a short reply. Every other reaction is dropped here. */
const REPLY_REACTION = "white_check_mark";

type SlackEnvelope = { type?: string; challenge?: string };

/** Slack Events API. The reply goes out before normalization so Slack never retries. */
export const slackRoutes = new Hono<HonoEnv>();

slackRoutes.post("/webhooks/slack", async (ctx) => {
  const secret = ctx.env.SLACK_SIGNING_SECRET;
  if (!secret) return secretNotConfigured(ctx, "SLACK_SIGNING_SECRET");
  const body = await ctx.req.text();
  if (!(await verifySlackWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);

  const payload = parseJsonBody(body) as SlackEnvelope | null;
  if (!payload) return ctx.text("malformed body", 400);
  if (payload.type === "url_verification") return ctx.json({ challenge: payload.challenge });
  if (payload.type !== "event_callback") return ctx.json({ ignored: payload.type });
  if (ctx.req.header("x-slack-retry-num")) return ctx.json({ ignored: "retry" }, 200, NO_RETRY);

  const clients = ctx.get("clients") ?? clientsFromEnv(ctx.env);
  ctx.executionCtx.waitUntil(handleCallback(ctx, clients, payload as SlackEventCallback));
  return ctx.json({ ok: true }, 200, NO_RETRY);
});

/** Greet, or normalize and deliver, after the reply has gone out. Errors go to the log. */
async function handleCallback(
  ctx: Context<HonoEnv>,
  clients: ChannelClients,
  callback: SlackEventCallback,
): Promise<void> {
  try {
    const channel = appJoinedChannel(callback);
    if (channel) {
      tagSpan(ctx, { "artfct.vendor": "slack", "artfct.event.kind": "greeting" });
      await clients.chat?.postChannelMessage(channel, GREETING);
      return;
    }
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
    if ("ignore" in normalized) return;
    await rpc.deliver(normalized.event);
  } catch (error) {
    console.error(`slack ${callback.event_id}: ${String(error)}`);
  }
}
