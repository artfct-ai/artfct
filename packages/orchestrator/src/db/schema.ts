import type { BindingSource, ConversationPlace } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Objects a workflow works on, each routing events to the conversation of the workflow that owns it. */
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

/** One row per place that has a conversation. The conversation id is derived from the place. */
export const conversations = sqliteTable(
  "conversations",
  {
    source: text().$type<ConversationPlace["source"]>().notNull(),
    external_id: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.source, table.external_id] })],
);

/**
 * One row per workflow from its creation, with the conversation that holds it and its status. The
 * router, the status call, and the sandbox bridge read it.
 */
export const workflows = sqliteTable("workflows", {
  workflow_id: text().primaryKey(),
  conversation_id: text().notNull(),
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
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

/** Pending OAuth `state` values. The install link mints one, the callback consumes it. */
export const linearOauthStates = sqliteTable("linear_oauth_states", {
  nonce: text().primaryKey(),
  expires_at: text().notNull(),
  created_at: text().notNull(),
});
