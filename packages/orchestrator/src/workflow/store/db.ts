import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import migrations from "../../../migrations/workflow/migrations.js";
import * as schema from "./schema";

/** Drizzle client over the workflow schema on any synchronous SQLite driver. */
export type WorkflowDb = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

/** Wrap DO storage in a Drizzle client and bring its tables up to date. Call once in `onStart`. */
export async function openWorkflowDb(
  storage: DurableObjectStorage,
): Promise<DrizzleSqliteDODatabase<typeof schema>> {
  const db = drizzle(storage, { schema });
  await migrate(db, migrations);
  return db;
}
