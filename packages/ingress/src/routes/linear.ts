import { Hono } from "hono";
import { linearInbound } from "@artfct-ai/adapters/tracker/linear/inbound";
import { linearVendorEvent } from "@artfct-ai/adapters/tracker/linear/vendor-event";
import { verifyLinearWebhook } from "@artfct-ai/adapters/tracker/linear/webhook";
import type { HonoEnv } from "../env";
import { parseJsonBody, secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/**
 * Linear webhooks. Linear expects a reply within 5 s. The conversational mapper's event is
 * delivered first. Then the Linear pass-through hands the delivery over as a vendor event or
 * drops it.
 */
export const linearRoutes = new Hono<HonoEnv>();

linearRoutes.post("/webhooks/linear", async (ctx) => {
  const secret = ctx.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return secretNotConfigured(ctx, "LINEAR_WEBHOOK_SECRET");
  const body = await ctx.req.text();
  if (!(await verifyLinearWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);
  const payload = parseJsonBody(body);

  const rpc = ctx.env.ORCHESTRATOR;
  const install = await rpc.trackerInstall();
  const deliveryId = ctx.req.header("linear-delivery") ?? null;
  const normalized = await linearInbound(payload, {
    workspaceId: install?.workspace_id ?? null,
    resolveActor: (user) => rpc.resolveActor({ source: "tracker", user }),
    deliveryId,
  });
  tagSpan(ctx, {
    "artfct.vendor": "linear",
    "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
  });
  const conversational =
    "ignore" in normalized ? { ignored: normalized.ignore } : await rpc.deliver(normalized.event);
  const passed = await linearVendorEvent(payload, { install, deliveryId });
  const vendorEvent =
    "drop" in passed ? { dropped: passed.drop } : await rpc.deliverVendorEvent(passed.event);
  return ctx.json({ conversational, vendor_event: vendorEvent });
});
