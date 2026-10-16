import type { Binding, BindingSource } from "@artfct-ai/contracts/sources";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { FINISHED_WORKFLOW_STATUSES } from "../workflow/store/state";
import { nowIso, type Database } from "./client";
import { bindings, workflows } from "./schema";

/** One row of the bindings table. */
export type BindingRow = typeof bindings.$inferSelect;

/** The workflow a binding points at, and how many claims moved it there. A claim names the holder it read. */
export type BindingHolder = Pick<BindingRow, "workflow_id" | "claim_seq">;

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

/** The holder of one external object's binding, or null. */
export async function findBinding(db: Database, binding: Binding): Promise<BindingHolder | null> {
  const row = await db
    .select({ workflow_id: bindings.workflow_id, claim_seq: bindings.claim_seq })
    .from(bindings)
    .where(and(eq(bindings.source, binding.source), eq(bindings.external_id, externalId(binding))))
    .get();
  return row ?? null;
}

/**
 * Point a binding at a workflow if it still has the holder the caller read. False when another
 * claim moved it first.
 */
export async function claimBinding(
  db: Database,
  binding: Binding,
  claim: { previous: BindingHolder | null; workflowId: string },
): Promise<boolean> {
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
    .set({ workflow_id: claim.workflowId, claim_seq: claim.previous.claim_seq + 1, created_at })
    .where(
      and(
        eq(bindings.source, binding.source),
        eq(bindings.external_id, externalId(binding)),
        eq(bindings.workflow_id, claim.previous.workflow_id),
        eq(bindings.claim_seq, claim.previous.claim_seq),
      ),
    )
    .returning({ workflow_id: bindings.workflow_id });
  return moved.length > 0;
}

/**
 * Point an external object at a workflow while the workflow's row has not ended. Replaces an
 * existing binding for it.
 */
export async function bindWorkflow(
  db: Database,
  binding: Binding,
  workflowId: string,
): Promise<void> {
  const live = db
    .select({
      source: sql<BindingSource>`${binding.source}`.as("source"),
      external_id: sql<string>`${externalId(binding)}`.as("external_id"),
      repo: sql<string | null>`${repoOf(binding)}`.as("repo"),
      workflow_id: workflows.workflow_id,
      claim_seq: sql<number>`0`.as("claim_seq"),
      created_at: sql<string>`${nowIso()}`.as("created_at"),
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workflow_id, workflowId),
        notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
      ),
    );
  await db
    .insert(bindings)
    .select(live)
    .onConflictDoUpdate({
      target: [bindings.source, bindings.external_id],
      set: {
        repo: sql`excluded.repo`,
        workflow_id: sql`excluded.workflow_id`,
        claim_seq: sql`${bindings.claim_seq} + 1`,
        created_at: sql`excluded.created_at`,
      },
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
