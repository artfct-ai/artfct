import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/env";

const D1_MIGRATIONS = join(import.meta.dirname, "../migrations/d1");

const MIGRATION_STATEMENTS = readdirSync(D1_MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .toSorted()
  .flatMap((file) =>
    readFileSync(join(D1_MIGRATIONS, file), "utf8").split("--> statement-breakpoint"),
  )
  .filter((statement) => statement.trim());

/** A value `bun:sqlite` binds. */
export type SqliteParam = string | number | bigint | boolean | null;

/** The D1 schema on a fresh in-memory `bun:sqlite` database, built from the generated migrations. */
export function migratedD1Database(): Database {
  const database = new Database(":memory:");
  for (const statement of MIGRATION_STATEMENTS) database.run(statement);
  return database;
}

/** The parameters of a D1 statement as `bun:sqlite` binds them. */
export function sqliteParams(params: unknown[]): SqliteParam[] {
  return params.map((param) => {
    if (
      param === null ||
      typeof param === "string" ||
      typeof param === "number" ||
      typeof param === "bigint" ||
      typeof param === "boolean"
    ) {
      return param;
    }
    throw new Error(`bun:sqlite cannot bind ${JSON.stringify(param)}`);
  });
}

/** A D1 binding over a fresh in-memory database with the D1 schema. Each statement runs when called. */
export function sqliteD1(): Env["DB"] {
  const sqlite = migratedD1Database();
  const statementOf = (sql: string, params: SqliteParam[]) => ({
    sql,
    params,
    run: async () => ({
      success: true,
      results: [],
      meta: { changes: sqlite.query(sql).run(...params).changes },
    }),
    all: async () => ({ success: true, results: sqlite.query(sql).all(...params), meta: {} }),
    raw: async () => sqlite.query(sql).values(...params),
    first: async () => sqlite.query(sql).get(...params),
  });
  type Statement = ReturnType<typeof statementOf>;
  const binding: object = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => statementOf(sql, sqliteParams(params)),
      ...statementOf(sql, []),
    }),
    batch: async (statements: Statement[]) => {
      const runAll = sqlite.transaction(() =>
        statements.map((statement) => ({
          success: true,
          results: sqlite.query(statement.sql).all(...statement.params),
          meta: {},
        })),
      );
      return runAll();
    },
  };
  return binding as Env["DB"];
}
