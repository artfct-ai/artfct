/**
 * The Worker's own credentials. Only the adapters the Worker builds read them, so an MCP server
 * in `artfct.yaml` may not reference one.
 */
export const WORKER_SECRETS = [
  "LINEAR_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
  "NOTION_TOKEN",
  "GITHUB_PRIVATE_KEY",
  "AI_GATEWAY_TOKEN",
  "OPEN_ROUTER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

type WorkerSecret = (typeof WORKER_SECRETS)[number];

/** True when `name` names one of the Worker's own credentials. */
export function isWorkerSecret(name: string): name is WorkerSecret {
  return (WORKER_SECRETS as readonly string[]).includes(name);
}

/**
 * Every value in `.dev.vars`, uploaded with `wrangler secret bulk`. All optional, since a
 * fresh clone has none. Bindings come from `wrangler types`.
 */
type Secrets = Partial<Record<WorkerSecret, string>> & {
  PUBLIC_URL?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_API_URL?: string;
  NOTION_API_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
};

export type Env = Cloudflare.Env & Secrets;

/** A `.dev.vars` value by a name `artfct.yaml` holds, which `Secrets` cannot list. */
export function envSecret(env: Env, name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
}
