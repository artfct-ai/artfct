import { Database, type Statement } from "bun:sqlite";
import { join } from "node:path";
import { getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
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
 * Compile each SQL text once. drizzle prepares a statement for every query and runs it to the
 * end with `run` or `values`, which reset it, so one statement serves every query of its text.
 */
function reuseCompiledStatements(database: Database): void {
  const compile = database.prepare.bind(database);
  const statements = new Map<string, Statement>();
  const prepareOnce = (sql: string): Statement => {
    const cached = statements.get(sql);
    if (cached) return cached;
    const compiled = compile(sql);
    statements.set(sql, compiled);
    return compiled;
  };
  database.prepare = prepareOnce as Database["prepare"];
}

/** The workflow schema on an in-memory `bun:sqlite` database. */
export type MemoryDb = BunSQLiteDatabase<typeof schema> & { $client: Database };

/**
 * The workflow schema on a fresh in-memory `bun:sqlite` database, with the same generated
 * migrations the Durable Object applies.
 */
export function openMemoryDb(): MemoryDb {
  const database = Database.deserialize(migratedDatabaseImage());
  reuseCompiledStatements(database);
  return drizzle(database, { schema });
}

/** Every row of every table of the store, by table name. */
export function storeRowsOf(db: MemoryDb): Record<string, unknown[]> {
  return Object.fromEntries(
    Object.values(schema)
      .filter((table) => is(table, SQLiteTable))
      .map((table) => [getTableName(table), db.select().from(table).all()]),
  );
}
