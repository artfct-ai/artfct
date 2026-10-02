import { and, eq } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { linearInstalls } from "./schema";

/** One row of the linear_installs table. */
export type LinearInstallRow = typeof linearInstalls.$inferSelect;

/** The token fields of an install. */
export type LinearTokenFields = {
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scope: string;
};

/** Everything an install records besides its timestamps. */
export type LinearInstallInput = LinearTokenFields & {
  organization_id: string;
  organization_name: string;
  app_user_id: string;
};

/** Record an install. A reinstall of the same workspace replaces its tokens. */
export async function saveLinearInstall(db: Database, input: LinearInstallInput): Promise<void> {
  const timestamp = nowIso();
  await db
    .insert(linearInstalls)
    .values({ ...input, created_at: timestamp, updated_at: timestamp })
    .onConflictDoUpdate({
      target: linearInstalls.organization_id,
      set: { ...input, updated_at: timestamp },
    });
}

/**
 * Replace the tokens after a refresh, only while the row still holds the refresh token that
 * was spent. False means another refresh landed first.
 */
export async function updateLinearTokens(
  db: Database,
  organizationId: string,
  spentRefreshToken: string,
  tokens: LinearTokenFields,
): Promise<boolean> {
  const updated = await db
    .update(linearInstalls)
    .set({ ...tokens, updated_at: nowIso() })
    .where(
      and(
        eq(linearInstalls.organization_id, organizationId),
        eq(linearInstalls.refresh_token, spentRefreshToken),
      ),
    )
    .returning({ organization_id: linearInstalls.organization_id });
  return updated.length > 0;
}

/** The install, when the agent is installed. The table holds at most one row. */
export async function readLinearInstall(db: Database): Promise<LinearInstallRow | null> {
  const row = await db.select().from(linearInstalls).limit(1).get();
  return row ?? null;
}
