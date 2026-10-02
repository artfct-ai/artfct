import { defineConfig } from "drizzle-kit";

/**
 * Emits SQL migrations for the Workflow Durable Object's SQLite storage, plus the
 * `migrations/migrations.js` bundle that the DO applies on start.
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/workflow/store/schema.ts",
  out: "./migrations/workflow",
});
