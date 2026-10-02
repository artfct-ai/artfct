import { isExpiring } from "@artfct-ai/adapters/expiry";
import {
  linearTokenExpiryIso,
  linearRefreshTokens,
  type LinearApiOptions,
  type LinearOAuthApp,
} from "@artfct-ai/adapters/tracker/linear/oauth";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { Database } from "../db/client";
import {
  readLinearInstall,
  updateLinearTokens,
  type LinearInstallRow,
  type LinearTokenFields,
} from "../db/linear-installs";
import type { Env } from "../env";

/** Refresh a token once it is this close to its expiry. */
export const REFRESH_MARGIN_MS = 10 * 60_000;

/**
 * Seams for tests: the clock, the fetch the OAuth token endpoint is reached through, and the
 * tracker an install asks who its token acts as.
 */
export type TokenOptions = {
  now?: () => number;
  fetch?: typeof fetch;
  tracker?: (token: string) => Tracker;
};

/** The OAuth app from the secrets, or null when either half is missing. */
export function linearOAuthApp(env: Env): LinearOAuthApp | null {
  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) return null;
  return { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET };
}

/** Where Linear's API is. `LINEAR_API_URL` points the smoke run at a fake server. */
export function linearApi(env: Env, fetchImpl?: typeof fetch): LinearApiOptions {
  return {
    ...(env.LINEAR_API_URL ? { baseUrl: env.LINEAR_API_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

/**
 * The access token of the install, held in memory and refreshed ahead of its expiry.
 * Concurrent calls share one refresh, and a refresh another isolate did is adopted.
 */
export class InstallToken {
  private refreshing: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(
    private row: LinearInstallRow,
    private readonly env: Env,
    private readonly db: Database,
    private readonly options: TokenOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The token to send now. */
  async current(): Promise<string> {
    if (!this.expiring(this.row)) return this.row.access_token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private expiring(row: LinearInstallRow): boolean {
    return isExpiring(Date.parse(row.expires_at), this.now(), REFRESH_MARGIN_MS);
  }

  private async refresh(): Promise<string> {
    const stored = await this.adoptStored();
    if (!this.expiring(stored)) return stored.access_token;
    const app = linearOAuthApp(this.env);
    if (!app || !stored.refresh_token) return stored.access_token;
    try {
      return await this.refreshWith(app, stored.refresh_token);
    } catch (error) {
      return this.afterFailedRefresh(error);
    }
  }

  /** Spend the refresh token. When another refresh spent it first, that refresh's tokens win. */
  private async refreshWith(app: LinearOAuthApp, refreshToken: string): Promise<string> {
    const tokens = await linearRefreshTokens(
      app,
      refreshToken,
      linearApi(this.env, this.options.fetch),
    );
    const fields: LinearTokenFields = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? refreshToken,
      expires_at: linearTokenExpiryIso(tokens, this.now()),
      scope: tokens.scope ?? this.row.scope,
    };
    const stored = await updateLinearTokens(
      this.db,
      this.row.organization_id,
      refreshToken,
      fields,
    );
    if (stored) this.row = { ...this.row, ...fields };
    else await this.adoptStored();
    return this.row.access_token;
  }

  /** Keep serving a token that is still valid after a refused refresh. A dead one throws. */
  private async afterFailedRefresh(error: unknown): Promise<string> {
    const stored = await this.adoptStored();
    if (!this.expiring(stored)) return stored.access_token;
    if (Date.parse(stored.expires_at) > this.now()) {
      console.warn(`linear: token refresh failed, keeping the current token: ${String(error)}`);
      return stored.access_token;
    }
    throw error;
  }

  /** Reread the install so a refresh done elsewhere is picked up. */
  private async adoptStored(): Promise<LinearInstallRow> {
    const stored = await readLinearInstall(this.db);
    if (stored) this.row = stored;
    return this.row;
  }
}
