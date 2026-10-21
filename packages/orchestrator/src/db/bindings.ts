import type { Binding, BindingSource } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { and, eq, exists, inArray, notInArray, sql } from "drizzle-orm";
import { FINISHED_WORKFLOW_STATUSES } from "../workflow/store/state";
import { nowIso, type Database } from "./client";
import { bindings, workflowPredecessors, workflows } from "./schema";

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

/** A binding claim: point it at `workflowId` if it still points at `previous`. */
type Claim = { previous: string | null; workflowId: string };

/** The statement of a binding claim. It returns the binding when the claim won. */
function claimStatement(db: Database, binding: Binding, claim: Claim) {
  const key = and(
    eq(bindings.source, binding.source),
    eq(bindings.external_id, externalId(binding)),
  );
  const created_at = nowIso();
  if (claim.previous === null) {
    return db
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
  }
  return db
    .update(bindings)
    .set({ workflow_id: claim.workflowId, created_at })
    .where(and(key, eq(bindings.workflow_id, claim.previous)))
    .returning({ workflow_id: bindings.workflow_id });
}

/**
 * Point a binding at a workflow if it still points at `previous`. False when another write
 * moved it first.
 */
export async function claimBinding(db: Database, binding: Binding, claim: Claim): Promise<boolean> {
  const claimed = await claimStatement(db, binding, claim);
  return claimed.length > 0;
}

/** The condition that a binding row is `binding` and points at `workflowId`. */
function bindingPointsAt(binding: Binding, workflowId: string) {
  return and(
    eq(bindings.source, binding.source),
    eq(bindings.external_id, externalId(binding)),
    eq(bindings.workflow_id, workflowId),
  );
}

/**
 * Claim the binding a new workflow starts from, and record the workflow whose end it replaces as
 * the predecessor, in one batch. The record lands only with the claim. False when the claim lost.
 */
export async function claimBindingAndRecordPredecessor(
  db: Database,
  binding: Binding,
  claim: Claim & { predecessorId: string },
): Promise<boolean> {
  const [claimed] = await db.batch([
    claimStatement(db, binding, claim),
    db.insert(workflowPredecessors).select(
      db
        .select({
          workflow_id: bindings.workflow_id,
          predecessor_id: sql<string>`${claim.predecessorId}`.as("predecessor_id"),
        })
        .from(bindings)
        .where(bindingPointsAt(binding, claim.workflowId)),
    ),
  ]);
  return claimed.length > 0;
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

/** A binding a new workflow claimed, and the workflow it pointed at before, if any. */
export type WonBinding = { binding: Binding; previous: string | null };

/**
 * Abandon a new workflow whose create threw, in one batch, while its row is still `new`. The
 * bindings it won go, each points back at the workflow it pointed at before, and the row turns
 * `failed`. A takeover of the create that marked the row first keeps them all.
 */
export async function abandonWorkflowCreate(
  db: Database,
  workflowId: string,
  won: WonBinding[],
): Promise<void> {
  const stillNew = and(eq(workflows.workflow_id, workflowId), eq(workflows.status, "new"));
  const whileNew = db
    .select({ workflow_id: workflows.workflow_id })
    .from(workflows)
    .where(stillNew);
  const timestamp = nowIso();
  const unbind = db.delete(bindings).where(
    and(
      eq(bindings.workflow_id, workflowId),
      inArray(
        bindings.source,
        won.map(({ binding }) => binding.source),
      ),
      exists(whileNew),
    ),
  );
  const restores = won.flatMap(({ binding, previous }) =>
    previous === null
      ? []
      : [
          db
            .insert(bindings)
            .select(
              db
                .select({
                  source: sql<BindingSource>`${binding.source}`.as("source"),
                  external_id: sql<string>`${externalId(binding)}`.as("external_id"),
                  repo: sql<string | null>`${repoOf(binding)}`.as("repo"),
                  workflow_id: sql<string>`${previous}`.as("workflow_id"),
                  created_at: sql<string>`${timestamp}`.as("created_at"),
                })
                .from(workflows)
                .where(stillNew),
            )
            .onConflictDoNothing(),
        ],
  );
  const markFailed = db
    .update(workflows)
    .set({ status: "failed", updated_at: timestamp })
    .where(stillNew);
  await db.batch([unbind, ...restores, markFailed]);
}

/**
 * Take over the create of a workflow whose create has not returned. Its row turns `running`, or is
 * inserted when missing, while `binding` still points at the workflow. Answers its predecessor, or
 * null when the binding moved or the row ended, such as when an abandon marked it failed.
 */
export async function takeOverWorkflowCreate(
  db: Database,
  binding: Binding,
  workflowId: string,
): Promise<{ predecessorId: string | null } | null> {
  const timestamp = nowIso();
  const running: WorkflowStatus = "running";
  const [taken, predecessors] = await db.batch([
    db
      .insert(workflows)
      .select(
        db
          .select({
            workflow_id: bindings.workflow_id,
            status: sql<WorkflowStatus>`${running}`.as("status"),
            created_at: sql<string>`${timestamp}`.as("created_at"),
            updated_at: sql<string>`${timestamp}`.as("updated_at"),
          })
          .from(bindings)
          .where(bindingPointsAt(binding, workflowId)),
      )
      .onConflictDoUpdate({
        target: workflows.workflow_id,
        set: { status: running, updated_at: timestamp },
        setWhere: notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
      })
      .returning({ workflow_id: workflows.workflow_id }),
    db
      .select({ predecessor_id: workflowPredecessors.predecessor_id })
      .from(workflowPredecessors)
      .where(eq(workflowPredecessors.workflow_id, workflowId)),
  ]);
  if (taken.length === 0) return null;
  return { predecessorId: predecessors[0]?.predecessor_id ?? null };
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
