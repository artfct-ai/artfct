import { and, eq, sql } from "drizzle-orm";
import { bindingExternalId } from "./bindings";
import type { Database } from "./client";
import { conversationIdOf } from "./conversations";
import { watches, workflows } from "./schema";
import { workflowRowLive } from "./workflows";

/** A pull request and the definition of the active workflow fired on it, which watches it. */
export type Watch = { repo: string; number: number; definition: string };

/** The key a pull request's watches are stored under. */
function pullKey({ repo, number }: { repo: string; number: number }) {
  return {
    source: "code_pull" as const,
    external_id: bindingExternalId({ source: "code_pull", repo, number }),
  };
}

/**
 * Record a watch while the watching workflow's row has not finished, so a write that lands after
 * the end does not bring the watch back. A row that exists stays.
 */
export function keepWatch(db: Database, watch: Watch, workflowId: string) {
  const { source, external_id } = pullKey(watch);
  const liveWatch = db
    .select({
      source: sql<typeof source>`${source}`.as("source"),
      external_id: sql<string>`${external_id}`.as("external_id"),
      definition: sql<string>`${watch.definition}`.as("definition"),
    })
    .from(workflows)
    .where(workflowRowLive(workflowId));
  return db.insert(watches).select(liveWatch).onConflictDoNothing();
}

/** Drop a watch. The pull request's events stop reaching that conversation. */
export function dropWatch(db: Database, watch: Watch) {
  const { source, external_id } = pullKey(watch);
  return db
    .delete(watches)
    .where(
      and(
        eq(watches.source, source),
        eq(watches.external_id, external_id),
        eq(watches.definition, watch.definition),
      ),
    );
}

/** The conversation of every workflow that watches the pull request. */
export async function watcherConversations(
  db: Database,
  pull: { repo: string; number: number },
): Promise<string[]> {
  const { source, external_id } = pullKey(pull);
  const rows = await db
    .select({ definition: watches.definition })
    .from(watches)
    .where(and(eq(watches.source, source), eq(watches.external_id, external_id)));
  return Promise.all(
    rows.map(({ definition }) =>
      conversationIdOf({
        source: "pull_request",
        repo: pull.repo,
        number: pull.number,
        definition,
      }),
    ),
  );
}
