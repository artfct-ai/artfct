import { isExpiring } from "@artfct-ai/adapters/expiry";
import type { Tracker, TrackerOAuth, TrackerTokens } from "@artfct-ai/adapters/tracker/types";
import type { Database } from "../db/client";
import {
  readLinearInstall,
  updateLinearTokens,
  type LinearInstallRow,
  type LinearTokenFields,
} from "../db/linear-installs";

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

/** The instant a token issued at `nowMs` stops working. */
export function tokenExpiryIso(tokens: TrackerTokens, nowMs: number): string {
  return new Date(nowMs + tokens.expires_in * 1000).toISOString();
}

/**
 * The access token of the install, held in memory and refreshed ahead of its expiry.
 * Concurrent calls share one refresh, and a refresh another isolate did is adopted.
 */
export class InstallToken {
  private refreshing: Promise<string> | null = null;

  constructor(
    private row: LinearInstallRow,
    private readonly db: Database,
    private readonly oauth: TrackerOAuth | null,
    private readonly now: () => number = Date.now,
  ) {}

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
    if (!this.oauth || !stored.refresh_token) return stored.access_token;
    try {
      return await this.refreshWith(this.oauth, stored.refresh_token);
    } catch (error) {
      return this.afterFailedRefresh(error);
    }
  }

  /** Spend the refresh token. When another refresh spent it first, that refresh's tokens win. */
  private async refreshWith(oauth: TrackerOAuth, refreshToken: string): Promise<string> {
    const tokens = await oauth.refreshTokens(refreshToken);
    const fields: LinearTokenFields = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? refreshToken,
      expires_at: tokenExpiryIso(tokens, this.now()),
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
