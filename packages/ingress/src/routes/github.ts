import { Hono } from "hono";
import { githubInbound } from "@artfct-ai/adapters/code/github/inbound";
import { verifyGithubWebhook } from "@artfct-ai/adapters/code/github/webhook";
import { ownGithubLogins } from "@artfct-ai/adapters/code/github/inbound-shared";
import type { HonoEnv } from "../env";
import { parseJsonBody, secretNotConfigured } from "./guards";
import { tagSpan } from "./span";

/** GitHub App webhooks. */
export const githubRoutes = new Hono<HonoEnv>();

githubRoutes.post("/webhooks/github", async (ctx) => {
  const secret = ctx.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return secretNotConfigured(ctx, "GITHUB_WEBHOOK_SECRET");
  const body = await ctx.req.text();
  if (!(await verifyGithubWebhook(secret, body, ctx.req.raw.headers)))
    return ctx.text("bad signature", 401);

  const eventName = ctx.req.header("x-github-event") ?? "";
  if (eventName === "ping") return ctx.json({ ok: true });
  const payload = parseJsonBody(body) as Record<string, unknown> | null;
  if (!payload) return ctx.text("malformed body", 400);

  const rpc = ctx.env.ORCHESTRATOR;
  const normalized = await githubInbound(eventName, payload, {
    resolveActor: (user) => rpc.resolveActor({ source: "code", user }),
    deliveryId: ctx.req.header("x-github-delivery") ?? crypto.randomUUID(),
    ownLogins: ownGithubLogins(ctx.env.GITHUB_APP_LOGIN),
  });
  tagSpan(ctx, {
    "artfct.vendor": "github",
    "artfct.event.kind": "ignore" in normalized ? undefined : normalized.event.kind,
  });
  if ("ignore" in normalized) return ctx.json({ ignored: normalized.ignore });

  return ctx.json(await rpc.deliver(normalized.event));
});
