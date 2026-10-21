import { eq, lt } from "drizzle-orm";
import { firingKey } from "../triggers/firing-key";
import type { TriggerFiring } from "../triggers/types";
import { nowIso, type Database } from "./client";
import { firingThreads } from "./schema";

/** A firing's start line: its channel, and the message that roots its thread. */
export type FiringThread = { channel: string; thread: string };

/** The start line recorded for a firing. Null before the first record. */
export async function recordedFiringThread(
  db: Database,
  firing: TriggerFiring,
): Promise<FiringThread | null> {
  const row = await db
    .select({ channel: firingThreads.channel, thread: firingThreads.thread })
    .from(firingThreads)
    .where(eq(firingThreads.firing_key, firingKey(firing)))
    .get();
  return row ?? null;
}

/**
 * Record a firing's start line unless a racing attempt recorded one first, and return the one
 * recorded, which every later attempt and duplicate of the firing uses.
 */
export async function keepFiringThread(
  db: Database,
  firing: TriggerFiring,
  thread: FiringThread,
): Promise<FiringThread> {
  await db
    .insert(firingThreads)
    .values({ firing_key: firingKey(firing), ...thread, created_at: nowIso() })
    .onConflictDoNothing();
  const recorded = await recordedFiringThread(db, firing);
  if (!recorded)
    throw new Error(`the start line of ${firingKey(firing)} is not recorded after its insert`);
  return recorded;
}

/** Delete the start lines recorded before the time, once the firing queue no longer holds their firings. */
export async function deleteFiringThreadsBefore(db: Database, before: Date): Promise<void> {
  await db.delete(firingThreads).where(lt(firingThreads.created_at, before.toISOString()));
}
