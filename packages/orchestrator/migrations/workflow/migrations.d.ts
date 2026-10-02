/**
 * Types for the `migrations.js` bundle that `drizzle-kit generate` writes next to this file.
 * The shape is what `drizzle-orm/durable-sqlite/migrator` accepts.
 */
declare const bundle: {
  journal: { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };
  migrations: Record<string, string>;
};
export default bundle;
