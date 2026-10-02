import { defineConfig } from "drizzle-kit";

/** Emits SQL migrations for the D1 database. Wrangler applies them (`db:migrate`). */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations/d1",
});
