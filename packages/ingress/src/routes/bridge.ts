import { BRIDGE_TOKEN_HEADER } from "@artfct-ai/acp/bridge-token";
import { Hono } from "hono";
import type { HonoEnv } from "../env";

/**
 * Bridge WebSocket. The sandbox dials wss://<ingress>/bridge/<workflow_id>/<task_id> with its
 * token in a header. The upgrade goes over the service binding to the orchestrator. Only the URL
 * and the token are forwarded, so no other header the caller sets reaches the Durable Object.
 */
export const bridgeRoutes = new Hono<HonoEnv>();

bridgeRoutes.get("/bridge/*", async (ctx) => {
  if (ctx.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return ctx.text("expected websocket", 426);
  }
  const headers = new Headers({ upgrade: "websocket" });
  const token = ctx.req.header(BRIDGE_TOKEN_HEADER);
  if (token) headers.set(BRIDGE_TOKEN_HEADER, token);
  return await ctx.env.ORCHESTRATOR.fetch(new Request(ctx.req.url, { headers }));
});
