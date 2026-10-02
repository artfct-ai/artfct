import { eq } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { linearOauthStates } from "./schema";

/** Remember a freshly minted state until `expiresAt`. */
export async function saveOauthState(
  db: Database,
  nonce: string,
  expiresAt: string,
): Promise<void> {
  await db.insert(linearOauthStates).values({ nonce, expires_at: expiresAt, created_at: nowIso() });
}

/**
 * Spend a state. True when it existed and was still fresh at `now`. The row is removed either
 * way.
 */
export async function consumeOauthState(
  db: Database,
  nonce: string,
  now: string,
): Promise<boolean> {
  const removed = await db
    .delete(linearOauthStates)
    .where(eq(linearOauthStates.nonce, nonce))
    .returning({ expires_at: linearOauthStates.expires_at });
  const row = removed[0];
  return row !== undefined && row.expires_at > now;
}
