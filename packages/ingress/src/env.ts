import type { OrchestratorRpc } from "@artfct-ai/contracts/types";
import type { ChannelClients } from "./clients";

/** Secrets set with `wrangler secret put`. A route without the secret it needs fails closed. */
type Secrets = {
  LINEAR_WEBHOOK_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  NOTION_VERIFICATION_TOKEN?: string;
  NOTION_TOKEN?: string;
  ADMIN_TOKEN?: string;
};

/** Plain vars set in `wrangler.jsonc`. `GITHUB_APP_LOGIN` names the GitHub App whose reviews are the orchestrator's own. */
type Vars = {
  GITHUB_APP_LOGIN: string;
  ADMIN_DEBUG?: string;
};

/** Everything the Worker reaches through `env`. The service binding is typed as the RPC contract. */
export type Env = Omit<Cloudflare.Env, keyof Secrets | keyof Vars | "ORCHESTRATOR"> &
  Secrets &
  Vars & { ORCHESTRATOR: OrchestratorRpc };

/** Hono generic so every route sees `ctx.env` as `Env`. `clients` is a test seam. */
export type HonoEnv = { Bindings: Env; Variables: { clients?: ChannelClients } };
