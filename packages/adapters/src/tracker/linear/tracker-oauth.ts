import type { TrackerOAuth, TrackerTokens } from "../types";
import { LINEAR_API_URL } from "./sdk";

/** Where the API is and how to reach it. Both are seams for tests and the smoke run. */
export type LinearApiOptions = { baseUrl?: string; fetch?: typeof fetch };

/** Scopes an agent install asks for. The `app:` pair makes the app mentionable and delegatable. */
const AGENT_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

/** Linear access tokens last a day. Assumed when the token endpoint sends no `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 24 * 60 * 60;

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

/** The Linear OAuth app. It installs as an app actor, so the app is mentionable and delegatable. */
export class LinearTrackerOAuth implements TrackerOAuth {
  constructor(
    private readonly app: LinearOAuthApp,
    private readonly options: LinearApiOptions = {},
  ) {}

  authorizeUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.app.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", AGENT_SCOPES.join(","));
    url.searchParams.set("actor", "app");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", input.state);
    return url.href;
  }

  exchangeCode(input: { code: string; redirectUri: string }): Promise<TrackerTokens> {
    const fields = {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    };
    return tokenRequest(this.app, fields, this.options);
  }

  refreshTokens(refreshToken: string): Promise<TrackerTokens> {
    const fields = { grant_type: "refresh_token", refresh_token: refreshToken };
    return tokenRequest(this.app, fields, this.options);
  }
}

/** The failure body of a refused grant. Linear sends both fields, other errors send neither. */
type TokenFailure = { error?: string; error_description?: string };

async function tokenRequest(
  app: LinearOAuthApp,
  fields: Record<string, string>,
  options: LinearApiOptions,
): Promise<TrackerTokens> {
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
  const { access_token, refresh_token, scope, expires_in } = payload;
  if (response.ok && access_token) {
    return {
      access_token,
      refresh_token,
      scope,
      expires_in: expires_in ?? DEFAULT_TOKEN_LIFETIME_S,
    };
  }
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
