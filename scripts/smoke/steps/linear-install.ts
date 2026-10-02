/**
 * Step 0. An admin fetches the install link, Linear sends them back to the OAuth callback, and
 * the orchestrator exchanges the code and stores the app-actor token. A replay of it fails.
 */
import { LINEAR_OAUTH_CALLBACK_PATH } from "../../../packages/ingress/src/routes/linear-oauth";
import { adminGet } from "../admin";
import { assert, assertEqual } from "../assert";
import { INGRESS_URL, LINEAR_CLIENT_ID } from "../config";
import { LINEAR_APP_USER, LINEAR_ORG } from "../fixtures";
import { fetchMockLinearState } from "../linear-api";

const CALLBACK_URL = `${INGRESS_URL}${LINEAR_OAUTH_CALLBACK_PATH}`;

/** Fetches the install link and checks that it targets Linear with the ingress callback. */
async function fetchInstallLink(): Promise<URL> {
  const link = await adminGet<{ url: string }>("/linear/install");
  const url = new URL(link.url);
  assertEqual(`${url.origin}${url.pathname}`, "https://linear.app/oauth/authorize", "install link");
  assertEqual(url.searchParams.get("client_id"), LINEAR_CLIENT_ID, "client id");
  assertEqual(url.searchParams.get("actor"), "app", "the app installs as an actor");
  assertEqual(url.searchParams.get("redirect_uri"), CALLBACK_URL, "callback on the ingress origin");
  assert(url.searchParams.get("state"), "link carries a state", link);
  return url;
}

/** Runs step 0. */
export async function runLinearInstall(): Promise<void> {
  console.log("\n0. Linear install");
  const link = await fetchInstallLink();
  const callback = `${CALLBACK_URL}?code=smoke-code&state=${link.searchParams.get("state")}`;

  const installed = await fetch(callback);
  const text = await installed.text();
  assertEqual(installed.status, 200, `install callback answered (${text.slice(0, 120)})`);
  assert(
    text.startsWith(`Installed in ${LINEAR_ORG.name} as app user ${LINEAR_APP_USER.id}.`),
    "callback names the workspace and the app user",
    text,
  );

  const replay = await fetch(callback);
  assertEqual(replay.status, 400, "a replayed callback is refused");
  assert((await replay.text()).includes("already used"), "the replay names the spent state");

  const mock = await fetchMockLinearState();
  assertEqual(
    mock.grants.map((grant) => [grant.grant_type, grant.code, grant.client_ok]),
    [["authorization_code", "smoke-code", true]],
    "one code exchange with the app credentials",
  );
  assertEqual(mock.grants[0]?.redirect_uri, CALLBACK_URL, "code exchange repeats the callback");
  assertEqual(
    mock.calls.map((call) => [call.operation, call.token_ok]),
    [
      ["viewer", true],
      ["organization", true],
    ],
    "the install read the viewer and its organization with the new token",
  );
}
