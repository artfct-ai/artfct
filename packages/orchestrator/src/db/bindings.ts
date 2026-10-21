import type { Binding, BindingSource } from "@artfct-ai/contracts/sources";
import { and, eq, exists, notInArray, sql } from "drizzle-orm";
import { FINISHED_WORKFLOW_STATUSES } from "../workflow/store/state";
import { nowIso, type Database } from "./client";
import { bindings, workflows } from "./schema";

/** One row of the bindings table. */
type BindingRow = typeof bindings.$inferSelect;

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

/** The condition that a binding row is `binding`. */
function bindingKeyIs(binding: Binding) {
  return and(eq(bindings.source, binding.source), eq(bindings.external_id, externalId(binding)));
}

/** The workflow bound to one object, or null. */
export async function findBinding(db: Database, binding: Binding): Promise<string | null> {
  const row = await db
    .select({ workflow_id: bindings.workflow_id })
    .from(bindings)
    .where(bindingKeyIs(binding))
    .get();
  return row?.workflow_id ?? null;
}

/** A binding claim: point it at `workflowId` if it still points at `previous`. */
type Claim = { previous: string | null; workflowId: string };

/** The condition that a workflow's row exists and has not finished. */
function workflowLive(workflowId: string) {
  return and(
    eq(workflows.workflow_id, workflowId),
    notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
  );
}

/** The binding row that points `binding` at a workflow, selected only while the workflow is live. */
function liveBindingRow(db: Database, binding: Binding, workflowId: string) {
  return db
    .select({
      source: sql<BindingSource>`${binding.source}`.as("source"),
      external_id: sql<string>`${externalId(binding)}`.as("external_id"),
      repo: sql<string | null>`${repoOf(binding)}`.as("repo"),
      workflow_id: workflows.workflow_id,
      created_at: sql<string>`${nowIso()}`.as("created_at"),
    })
    .from(workflows)
    .where(workflowLive(workflowId));
}

/**
 * Point a binding at a live workflow if it still points at `previous`. False when another write
 * moved it first, or when the workflow's row finished.
 */
export async function claimBinding(db: Database, binding: Binding, claim: Claim): Promise<boolean> {
  if (claim.previous === null) {
    const inserted = await db
      .insert(bindings)
      .select(liveBindingRow(db, binding, claim.workflowId))
      .onConflictDoNothing()
      .returning({ workflow_id: bindings.workflow_id });
    return inserted.length > 0;
  }
  const liveClaimer = db
    .select({ workflow_id: workflows.workflow_id })
    .from(workflows)
    .where(workflowLive(claim.workflowId));
  const moved = await db
    .update(bindings)
    .set({ workflow_id: claim.workflowId, created_at: nowIso() })
    .where(
      and(bindingKeyIs(binding), eq(bindings.workflow_id, claim.previous), exists(liveClaimer)),
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
  await db
    .insert(bindings)
    .select(liveBindingRow(db, binding, workflowId))
    .onConflictDoUpdate({
      target: [bindings.source, bindings.external_id],
      set: {
        repo: sql`excluded.repo`,
        workflow_id: sql`excluded.workflow_id`,
        created_at: sql`excluded.created_at`,
      },
    });
}

/** Drop every binding of one workflow. Its objects stop routing to its conversation. */
export async function deleteBindings(db: Database, workflowId: string): Promise<void> {
  await db.delete(bindings).where(eq(bindings.workflow_id, workflowId));
}

/** The condition that the workflow a binding row names has a row that has not finished. */
const workflowNotFinished = and(
  eq(workflows.workflow_id, bindings.workflow_id),
  notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
);

/**
 * The conversation of the first binding whose workflow has not finished, in the order given. Null
 * when none of them leads to one.
 */
export async function findBoundConversation(
  db: Database,
  objects: Binding[],
): Promise<string | null> {
  for (const binding of objects) {
    const row = await db
      .select({ conversation_id: workflows.conversation_id })
      .from(bindings)
      .innerJoin(workflows, workflowNotFinished)
      .where(bindingKeyIs(binding))
      .get();
    if (row) return row.conversation_id;
  }
  return null;
}

/** One binding as admins list it, with the conversation of its workflow. */
export type ListedBinding = BindingRow & { conversation_id: string };

/** Every binding with its workflow's conversation, oldest first. */
export async function listBindings(db: Database): Promise<ListedBinding[]> {
  const rows = await db
    .select({ binding: bindings, conversation_id: workflows.conversation_id })
    .from(bindings)
    .innerJoin(workflows, eq(workflows.workflow_id, bindings.workflow_id))
    .orderBy(bindings.created_at);
  return rows.map((row) => ({ ...row.binding, conversation_id: row.conversation_id }));
}

/** Conversations whose running workflow has a pull request bound in this repository, each named once. */
export async function conversationsWithPullsInRepo(db: Database, repo: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ conversation_id: workflows.conversation_id })
    .from(bindings)
    .innerJoin(workflows, workflowNotFinished)
    .where(and(eq(bindings.source, "code_pull"), eq(bindings.repo, repo)));
  return rows.map((row) => row.conversation_id);
}
