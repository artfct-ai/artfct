import { Hono } from "hono";
import { githubInbound } from "@artfct-ai/adapters/code/github/inbound";
import { verifyGithubWebhook } from "@artfct-ai/adapters/code/github/webhook";
import { ownGithubLogins } from "@artfct-ai/adapters/code/github/inbound-shared";
import { githubVendorEvent } from "@artfct-ai/adapters/code/github/vendor-event";
import type { HonoEnv } from "../env";
import { parseJsonBody, secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/**
 * GitHub App webhooks. The conversational mapper's event is delivered first, so a watcher's end
 * on a closed pull request starts before the pass-through's vendor event queues its firings.
 */
export const githubRoutes = new Hono<HonoEnv>();

githubRoutes.post("/webhooks/github", async (ctx) => {
  const secret = ctx.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return secretNotConfigured(ctx, "GITHUB_WEBHOOK_SECRET");
  const body = await ctx.req.text();
  if (!(await verifyGithubWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);

  const eventName = ctx.req.header("x-github-event") ?? "";
  if (eventName === "ping") return ctx.json({ ok: true });
  const payload = parseJsonBody(body);
  if (!payload) return ctx.text("malformed body", 400);

  const rpc = ctx.env.ORCHESTRATOR;
  const deliveryId = ctx.req.header("x-github-delivery") ?? crypto.randomUUID();
  const ownLogins = ownGithubLogins(ctx.env.GITHUB_APP_LOGIN);
  const normalized = await githubInbound(eventName, payload, {
    resolveActor: (user) => rpc.resolveActor({ source: "code", user }),
    deliveryId,
    ownLogins,
  });
  tagSpan(ctx, {
    "artfct.vendor": "github",
    "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
  });
  const conversational =
    "ignore" in normalized ? { ignored: normalized.ignore } : await rpc.deliver(normalized.event);
  const passed = githubVendorEvent(eventName, payload, { deliveryId, ownLogins });
  const vendorEvent =
    "drop" in passed ? { dropped: passed.drop } : await rpc.deliverVendorEvent(passed.event);
  return ctx.json({ conversational, vendor_event: vendorEvent });
});
