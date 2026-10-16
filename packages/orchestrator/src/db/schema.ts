import type { BindingSource } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** People known to the orchestrator, joined across the tracker, chat, code host, and documents. */
export const persons = sqliteTable("persons", {
  person_id: text().primaryKey(),
  email: text().unique(),
  linear_user_id: text().unique(),
  slack_user_id: text().unique(),
  github_login: text().unique(),
  display_name: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

/** External ids that route inbound events to a workflow. */
export const bindings = sqliteTable(
  "bindings",
  {
    source: text().$type<BindingSource>().notNull(),
    external_id: text().notNull(),
    repo: text(),
    workflow_id: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.external_id] }),
    index("bindings_workflow").on(table.workflow_id),
  ],
);

/** One row per workflow with its lifecycle status. The router reads the status. */
export const workflows = sqliteTable("workflows", {
  workflow_id: text().primaryKey(),
  status: text().$type<WorkflowStatus>().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

/**
 * The Linear OAuth app install. One deployment serves one workspace, so the table holds at
 * most one row. The app-actor token is refreshed in place.
 */
export const linearInstalls = sqliteTable("linear_installs", {
  organization_id: text().primaryKey(),
  organization_name: text().notNull(),
  app_user_id: text().notNull(),
  access_token: text().notNull(),
  refresh_token: text(),
  expires_at: text().notNull(),
  scope: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

/** Pending OAuth `state` values. The install link mints one, the callback consumes it. */
export const linearOauthStates = sqliteTable("linear_oauth_states", {
  nonce: text().primaryKey(),
  expires_at: text().notNull(),
  created_at: text().notNull(),
});
