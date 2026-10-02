import { Hono } from "hono";
import type { Context } from "hono";
import type { HonoEnv } from "../env";

/** The ingress path Linear redirects to after an admin approves the agent install. */
export const LINEAR_OAUTH_CALLBACK_PATH = "/linear/oauth/callback";

/** The callback URL Linear sends the admin back to, read from the request being served. */
export function linearCallbackUrl(ctx: Context<HonoEnv>): string {
  return new URL(LINEAR_OAUTH_CALLBACK_PATH, ctx.req.url).toString();
}

/** Where Linear sends the admin after they approve the install. */
export const linearOauthRoutes = new Hono<HonoEnv>();

linearOauthRoutes.get(LINEAR_OAUTH_CALLBACK_PATH, async (ctx) => {
  const { code, state, error } = ctx.req.query();
  if (error) return ctx.text(`Linear refused the install: ${error}`, 400);
  if (!code || !state) return ctx.text("missing code or state", 400);
  const redirect_uri = linearCallbackUrl(ctx);
  const result = await ctx.env.ORCHESTRATOR.linearInstall({ code, state, redirect_uri });
  if (!result.installed) return ctx.text(`Install failed: ${result.error}`, 400);
  return ctx.text(
    `Installed in ${result.organization} as app user ${result.app_user_id}. ` +
      "Delegate an issue to the agent, or mention it in a comment, to start a workflow.",
  );
});
