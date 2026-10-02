import { Database } from "bun:sqlite";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../src/workflow/store/schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../migrations/workflow");

let migratedImage: Uint8Array | null = null;

/** The bytes of a database with every migration applied. The migrations run once per process. */
function migratedDatabaseImage(): Uint8Array {
  if (migratedImage) return migratedImage;
  const database = new Database(":memory:");
  migrate(drizzle(database, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  migratedImage = database.serialize();
  return migratedImage;
}

/**
 * The workflow schema on a fresh in-memory `bun:sqlite` database, with the same generated
 * migrations the Durable Object applies.
 */
export function openMemoryDb(): BunSQLiteDatabase<typeof schema> {
  return drizzle(Database.deserialize(migratedDatabaseImage()), { schema });
}
