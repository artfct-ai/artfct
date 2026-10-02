import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { createDb } from "./src/db/client";
import { bindings, linearInstalls, linearOauthStates, persons, workflows } from "./src/db/schema";
import "./test/register-config";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

/**
 * The migrations go in through `env.DB` directly, so this file imports nothing from
 * `cloudflare:test` and no test isolate loads the Worker entrypoint unless it asks for it.
 */
const statements = env.TEST_MIGRATIONS.flatMap((migration) =>
  migration.queries.map((sql) => env.DB.prepare(sql)),
);
await env.DB.batch(statements);

/** Storage is isolated per test file, so each test starts from empty tables by hand. */
beforeEach(async () => {
  const db = createDb(env.DB);
  await db.delete(bindings);
  await db.delete(persons);
  await db.delete(workflows);
  await db.delete(linearInstalls);
  await db.delete(linearOauthStates);
});
