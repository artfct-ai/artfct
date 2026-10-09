import type { Binding, BindingSource } from "@artfct-ai/contracts/sources";
import { and, eq, inArray } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { bindings } from "./schema";

/** One row of the bindings table. */
export type BindingRow = typeof bindings.$inferSelect;

/** The text key a binding is stored under. */
function externalId(binding: Binding): string {
  switch (binding.source) {
    case "code_pull":
      return `${binding.repo}#${binding.number}`;
    case "code_branch":
      return `${binding.repo}:${binding.branch}`;
    default:
      return binding.external_id;
  }
}

/** The repository a code binding names. Null for every other source. */
function repoOf(binding: Binding): string | null {
  switch (binding.source) {
    case "code_pull":
    case "code_branch":
      return binding.repo;
    default:
      return null;
  }
}

/** Workflow bound to one external object, or null. */
export async function findBinding(db: Database, binding: Binding): Promise<string | null> {
  const row = await db
    .select({ workflow_id: bindings.workflow_id })
    .from(bindings)
    .where(and(eq(bindings.source, binding.source), eq(bindings.external_id, externalId(binding))))
    .get();
  return row?.workflow_id ?? null;
}

/**
 * Point a binding at a workflow if it still points at `previous`. False when another delivery
 * moved it first.
 */
export async function claimBinding(
  db: Database,
  binding: Binding,
  claim: { previous: string | null; workflowId: string },
): Promise<boolean> {
  const key = and(
    eq(bindings.source, binding.source),
    eq(bindings.external_id, externalId(binding)),
  );
  const created_at = nowIso();
  if (claim.previous === null) {
    const inserted = await db
      .insert(bindings)
      .values({
        source: binding.source,
        external_id: externalId(binding),
        repo: repoOf(binding),
        workflow_id: claim.workflowId,
        created_at,
      })
      .onConflictDoNothing()
      .returning({ workflow_id: bindings.workflow_id });
    return inserted.length > 0;
  }
  const moved = await db
    .update(bindings)
    .set({ workflow_id: claim.workflowId, created_at })
    .where(and(key, eq(bindings.workflow_id, claim.previous)))
    .returning({ workflow_id: bindings.workflow_id });
  return moved.length > 0;
}

/** Point an external object at a workflow. Replaces an existing binding for it. */
export async function bindWorkflow(
  db: Database,
  binding: Binding,
  workflowId: string,
): Promise<void> {
  const row = {
    source: binding.source,
    external_id: externalId(binding),
    repo: repoOf(binding),
    workflow_id: workflowId,
    created_at: nowIso(),
  };
  await db
    .insert(bindings)
    .values(row)
    .onConflictDoUpdate({
      target: [bindings.source, bindings.external_id],
      set: { repo: row.repo, workflow_id: row.workflow_id, created_at: row.created_at },
    });
}

/** Drop the bindings of one workflow whose source is one of `sources`. The rest keep routing to it. */
export async function deleteBindings(
  db: Database,
  workflowId: string,
  sources: BindingSource[],
): Promise<void> {
  await db
    .delete(bindings)
    .where(and(eq(bindings.workflow_id, workflowId), inArray(bindings.source, sources)));
}

/** Every binding, oldest first. */
export async function listBindings(db: Database): Promise<BindingRow[]> {
  return db.select().from(bindings).orderBy(bindings.created_at);
}

/** Workflows with a pull request bound in this repository, each named once. */
export async function workflowsWithPullsInRepo(db: Database, repo: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workflow_id: bindings.workflow_id })
    .from(bindings)
    .where(and(eq(bindings.source, "code_pull"), eq(bindings.repo, repo)));
  return rows.map((row) => row.workflow_id);
}
