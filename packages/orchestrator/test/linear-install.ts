import { APP_USER } from "@artfct-ai/adapters/test/fake-tracker";
import type { LinearInstallInput } from "../src/db/linear-installs";

/** What the token endpoint answers by default: a pair that lasts a day. */
export const TOKENS = {
  access_token: "lin_oauth_a",
  refresh_token: "r1",
  expires_in: 86399,
  scope: "read,write,app:assignable,app:mentionable",
};

/** The install row a completed OAuth flow stores for `APP_USER`. */
export function installRow(patch: Partial<LinearInstallInput> = {}): LinearInstallInput {
  return {
    organization_id: APP_USER.organization.id,
    organization_name: APP_USER.organization.name,
    app_user_id: APP_USER.id,
    access_token: "lin_oauth_a",
    refresh_token: "r1",
    expires_at: "2026-09-04T10:00:00.000Z",
    scope: "read,write",
    ...patch,
  };
}
