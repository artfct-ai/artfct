import { Hono } from "hono";
import { linearInbound } from "@artfct-ai/adapters/tracker/linear/inbound";
import type { LinearPayload } from "@artfct-ai/adapters/tracker/linear/inbound-payloads";
import { verifyLinearWebhook } from "@artfct-ai/adapters/tracker/linear/webhook";
import type { HonoEnv } from "../env";
import { secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/** Linear webhooks. Linear expects a reply within 5 s. */
export const linearRoutes = new Hono<HonoEnv>();

linearRoutes.post("/webhooks/linear", async (ctx) => {
  const secret = ctx.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return secretNotConfigured(ctx, "LINEAR_WEBHOOK_SECRET");
  const body = await ctx.req.text();
  if (!(await verifyLinearWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);
  const payload = JSON.parse(body) as LinearPayload;

  const rpc = ctx.env.ORCHESTRATOR;
  const normalized = await linearInbound(payload, {
    workspaceId: await rpc.trackerWorkspace(),
    resolveActor: (user) => rpc.resolveActor({ source: "tracker", user }),
    deliveryId: ctx.req.header("linear-delivery") ?? null,
  });
  tagSpan(ctx, {
    "artfct.vendor": "linear",
    "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
  });
  if ("ignore" in normalized) return ctx.json({ ignored: normalized.ignore });
  return ctx.json(await rpc.deliver(normalized.event));
});
