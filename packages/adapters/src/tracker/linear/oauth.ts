import { LINEAR_API_URL } from "./sdk";

/** Where the API is and how to reach it. Both are seams for tests and the smoke run. */
export type LinearApiOptions = { baseUrl?: string; fetch?: typeof fetch };

/** Scopes an agent install asks for. The `app:` pair makes the app mentionable and delegatable. */
export const AGENT_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

/** Linear access tokens last a day. Assumed when the token endpoint sends no `expires_in`. */
export const DEFAULT_TOKEN_LIFETIME_S = 24 * 60 * 60;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";

/** What Linear returns from the token endpoint. `refresh_token` is absent on some grants. */
export type LinearTokens = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

/** The OAuth app as registered in Linear. */
export type LinearOAuthApp = { clientId: string; clientSecret: string };

/** The authorize URL for an app-actor install. The workspace admin opens it in a browser. */
export function linearAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", AGENT_SCOPES.join(","));
  url.searchParams.set("actor", "app");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.href;
}

/** Trade the authorization code from the callback for tokens. */
export function linearExchangeCode(
  app: LinearOAuthApp,
  input: { code: string; redirectUri: string },
  options: LinearApiOptions = {},
): Promise<LinearTokens> {
  const fields = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  };
  return tokenRequest(app, fields, options);
}

/** Trade a refresh token for a new access token and refresh token. */
export function linearRefreshTokens(
  app: LinearOAuthApp,
  refreshToken: string,
  options: LinearApiOptions = {},
): Promise<LinearTokens> {
  return tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken }, options);
}

/** The instant a token issued now stops working. Linear's default applies without `expires_in`. */
export function linearTokenExpiryIso(tokens: LinearTokens, nowMs = Date.now()): string {
  const seconds = tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_S;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** The failure body of a refused grant. Linear sends both fields, other errors send neither. */
type TokenFailure = { error?: string; error_description?: string };

async function tokenRequest(
  app: LinearOAuthApp,
  fields: Record<string, string>,
  options: LinearApiOptions,
): Promise<LinearTokens> {
  const body = new URLSearchParams({
    ...fields,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(`${options.baseUrl ?? LINEAR_API_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  const payload = parseTokenBody(text);
  if (response.ok && payload.access_token) return payload as LinearTokens;
  const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status} ${text}`;
  throw new Error(`linear oauth ${fields.grant_type}: ${reason}`);
}

function parseTokenBody(text: string): Partial<LinearTokens> & TokenFailure {
  try {
    return JSON.parse(text) as Partial<LinearTokens> & TokenFailure;
  } catch {
    return {};
  }
}
