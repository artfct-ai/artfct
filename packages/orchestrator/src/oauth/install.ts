import {
  linearAuthorizeUrl,
  linearExchangeCode,
  linearTokenExpiryIso,
} from "@artfct-ai/adapters/tracker/linear/oauth";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type {
  LinearInstallInput,
  LinearInstallLink,
  LinearInstallResult,
} from "@artfct-ai/contracts/types";
import { trackerForToken } from "../clients";
import type { Database } from "../db/client";
import { readLinearInstall, saveLinearInstall } from "../db/linear-installs";
import { consumeOauthState, saveOauthState } from "../db/linear-oauth-states";
import type { Env } from "../env";
import { newToken } from "../ids";
import { linearApi, linearOAuthApp, type TokenOptions } from "./token";

/** How long an install link stays valid. */
export const STATE_LIFETIME_MS = 15 * 60_000;

/** The message when the OAuth app secrets are missing. */
export const OAUTH_NOT_CONFIGURED = "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are not set";

const BAD_STATE = "state is invalid, expired, or already used. Request a new install link.";

/**
 * A fresh install link for the callback ingress names. The callback accepts the state inside
 * it once, and only within `STATE_LIFETIME_MS`.
 */
export async function linearInstallUrl(
  env: Env,
  db: Database,
  input: { redirect_uri: string },
  options: TokenOptions = {},
): Promise<LinearInstallLink> {
  const app = linearOAuthApp(env);
  if (!app) return { error: OAUTH_NOT_CONFIGURED };
  const now = (options.now ?? Date.now)();
  const state = newToken();
  await saveOauthState(db, state, new Date(now + STATE_LIFETIME_MS).toISOString());
  const redirectUri = input.redirect_uri;
  return { url: linearAuthorizeUrl({ clientId: app.clientId, redirectUri, state }) };
}

/**
 * Finish an install from the OAuth callback. The state is spent here, and the redirect URI the
 * callback repeats is the one Linear checks against the link.
 */
export async function completeLinearInstall(
  env: Env,
  db: Database,
  input: LinearInstallInput,
  options: TokenOptions = {},
): Promise<LinearInstallResult> {
  const app = linearOAuthApp(env);
  if (!app) return { installed: false, error: OAUTH_NOT_CONFIGURED };
  const now = (options.now ?? Date.now)();
  const fresh = await consumeOauthState(db, input.state, new Date(now).toISOString());
  if (!fresh) return { installed: false, error: BAD_STATE };
  try {
    const redirectUri = input.redirect_uri;
    return await installFromCode(env, db, { code: input.code, redirectUri }, options);
  } catch (error) {
    return { installed: false, error: String(error) };
  }
}

/** Exchange the code, learn who the token acts as, and store the install for that workspace. */
async function installFromCode(
  env: Env,
  db: Database,
  input: { code: string; redirectUri: string },
  options: TokenOptions,
): Promise<LinearInstallResult> {
  const app = linearOAuthApp(env);
  if (!app) return { installed: false, error: OAUTH_NOT_CONFIGURED };
  const tokens = await linearExchangeCode(app, input, linearApi(env, options.fetch));
  const appUser = await trackerFor(env, options, tokens.access_token).appUser();
  const existing = await readLinearInstall(db);
  if (existing && existing.organization_id !== appUser.organization.id) {
    const error = `already installed in workspace ${existing.organization_name}. One deployment serves one workspace.`;
    return { installed: false, error };
  }
  await saveLinearInstall(db, {
    organization_id: appUser.organization.id,
    organization_name: appUser.organization.name,
    app_user_id: appUser.id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: linearTokenExpiryIso(tokens, (options.now ?? Date.now)()),
    scope: tokens.scope ?? "",
  });
  return { installed: true, organization: appUser.organization.name, app_user_id: appUser.id };
}

/** The tracker a fresh token is asked through. Tests hand in a fake. */
function trackerFor(env: Env, options: TokenOptions, token: string): Tracker {
  if (options.tracker) return options.tracker(token);
  return trackerForToken(env, token);
}
