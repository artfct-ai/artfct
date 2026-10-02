/**
 * Every value in `.dev.vars`, uploaded with `wrangler secret bulk`. All optional, since a
 * fresh clone has none. Bindings come from `wrangler types`.
 */
type Secrets = {
  PUBLIC_URL?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_API_URL?: string;
  SLACK_BOT_TOKEN?: string;
  NOTION_TOKEN?: string;
  NOTION_API_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;
  OPEN_ROUTER_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
};

export type Env = Cloudflare.Env & Secrets;

/** A `.dev.vars` value by a name `artfct.yaml` holds, which `Secrets` cannot list. */
export function envSecret(env: Env, name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
}
