import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

/** Drizzle client over the shared D1 database with the full schema attached. */
export type Database = DrizzleD1Database<typeof schema>;

/** Wrap a D1 binding in a Drizzle client. Cheap, so call it once per request. */
export function createDb(d1: D1Database): Database {
  return drizzle(d1, { schema });
}

/** Current time as an ISO string, the format every timestamp column stores. */
export function nowIso(): string {
  return new Date().toISOString();
}
