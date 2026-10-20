import type { Binding, BindingSource } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { and, eq, exists, inArray, notInArray, sql } from "drizzle-orm";
import { FINISHED_WORKFLOW_STATUSES } from "../workflow/store/state";
import { nowIso, type Database } from "./client";
import { bindings, workflows } from "./schema";

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
 * Point a binding at a workflow if it still points at `previous`. False when another write
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

/**
 * Drop the bindings a new workflow took on `sources` while its row is still `new`, so the router
 * abandons it. False when a takeover of its create marked the row first, and the bindings stay.
 */
export async function deleteBindingsOfNewWorkflow(
  db: Database,
  workflowId: string,
  sources: BindingSource[],
): Promise<boolean> {
  const stillNew = db
    .select({ workflow_id: workflows.workflow_id })
    .from(workflows)
    .where(and(eq(workflows.workflow_id, workflowId), eq(workflows.status, "new")));
  const deleted = await db
    .delete(bindings)
    .where(
      and(
        eq(bindings.workflow_id, workflowId),
        inArray(bindings.source, sources),
        exists(stillNew),
      ),
    )
    .returning({ workflow_id: bindings.workflow_id });
  return deleted.length > 0;
}

/**
 * Take over the create of a workflow whose create has not returned. Its row turns `running`, or is
 * inserted when missing, while `binding` still points at the workflow. False when the binding moved
 * or the row ended, such as when an abandon marked it failed.
 */
export async function takeOverWorkflowCreate(
  db: Database,
  binding: Binding,
  workflowId: string,
): Promise<boolean> {
  const timestamp = nowIso();
  const running: WorkflowStatus = "running";
  const stillBound = db
    .select({
      workflow_id: bindings.workflow_id,
      status: sql<WorkflowStatus>`${running}`.as("status"),
      created_at: sql<string>`${timestamp}`.as("created_at"),
      updated_at: sql<string>`${timestamp}`.as("updated_at"),
    })
    .from(bindings)
    .where(
      and(
        eq(bindings.source, binding.source),
        eq(bindings.external_id, externalId(binding)),
        eq(bindings.workflow_id, workflowId),
      ),
    );
  const taken = await db
    .insert(workflows)
    .select(stillBound)
    .onConflictDoUpdate({
      target: workflows.workflow_id,
      set: { status: running, updated_at: timestamp },
      setWhere: notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
    })
    .returning({ workflow_id: workflows.workflow_id });
  return taken.length > 0;
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
