import { Hono } from "hono";
import type { HonoEnv } from "./env";
import { adminRoutes } from "./routes/admin";
import { bridgeRoutes } from "./routes/bridge";
import { githubRoutes } from "./routes/github";
import { linearRoutes } from "./routes/linear";
import { linearOauthRoutes } from "./routes/linear-oauth";
import { notionRoutes } from "./routes/notion";
import { slackRoutes } from "./routes/slack";

/** Ingress Worker. Verifies webhooks, normalizes them, and delivers them to the orchestrator. */
const app = new Hono<HonoEnv>();

app.get("/healthz", (ctx) => ctx.text("ok"));
app.route("/", linearRoutes);
app.route("/", linearOauthRoutes);
app.route("/", githubRoutes);
app.route("/", slackRoutes);
app.route("/", notionRoutes);
app.route("/", bridgeRoutes);
app.route("/admin", adminRoutes);

export default app;
