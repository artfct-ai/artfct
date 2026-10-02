import { Hono } from "hono";
import { timingSafeEqual } from "@artfct-ai/adapters/hmac";
import type { HonoEnv } from "../env";
import { linearCallbackUrl } from "./linear-oauth";

/** The install link, and the dumps when `ADMIN_DEBUG` marks local dev. Guarded by `ADMIN_TOKEN`. */
export const adminRoutes = new Hono<HonoEnv>();

adminRoutes.use("*", async (ctx, next) => {
  const { ADMIN_TOKEN, ADMIN_DEBUG } = ctx.env;
  const isDump = !ctx.req.path.endsWith("/linear/install");
  if (isDump && ADMIN_DEBUG !== "true") return ctx.notFound();
  const token = ctx.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!ADMIN_TOKEN || !timingSafeEqual(ADMIN_TOKEN, token)) return ctx.text("unauthorized", 401);
  return next();
});

adminRoutes.get("/workflows/:id", async (ctx) =>
  ctx.json(await ctx.env.ORCHESTRATOR.status(ctx.req.param("id"))),
);

adminRoutes.get("/workflows/:id/debug", async (ctx) =>
  ctx.json(await ctx.env.ORCHESTRATOR.debug(ctx.req.param("id"))),
);

adminRoutes.get("/bindings", async (ctx) => ctx.json(await ctx.env.ORCHESTRATOR.bindings()));

/** The link a workspace admin opens to install the Linear agent. The state inside it works once. */
adminRoutes.get("/linear/install", async (ctx) => {
  const link = await ctx.env.ORCHESTRATOR.linearInstallUrl({
    redirect_uri: linearCallbackUrl(ctx),
  });
  if ("error" in link) return ctx.json(link, 503);
  return ctx.json(link);
});
