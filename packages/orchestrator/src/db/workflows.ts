import { and, eq, notInArray } from "drizzle-orm";
import { FINISHED_WORKFLOW_STATUSES } from "../workflow/store/state";
import { nowIso, type Database } from "./client";
import { workflows } from "./schema";

/** One row of the workflows table. */
export type WorkflowRow = typeof workflows.$inferSelect;

/** What a conversation writes to the router's row of one of its workflows. */
export type WorkflowRecord = Pick<WorkflowRow, "workflow_id" | "conversation_id" | "status">;

/**
 * Write the router's row of a workflow with its current status. The first write inserts it, and
 * every later one, such as a restart's write again, sets the status. A finished row stays finished,
 * so a running status that lands after the end does not revive it.
 */
export function writeWorkflowRow(db: Database, record: WorkflowRecord) {
  const timestamp = nowIso();
  return db
    .insert(workflows)
    .values({ ...record, created_at: timestamp, updated_at: timestamp })
    .onConflictDoUpdate({
      target: workflows.workflow_id,
      set: { status: record.status, updated_at: timestamp },
      setWhere: notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
    });
}

/** The condition that a workflow's row exists and has not finished. */
export function workflowRowLive(workflowId: string) {
  return and(
    eq(workflows.workflow_id, workflowId),
    notInArray(workflows.status, FINISHED_WORKFLOW_STATUSES),
  );
}

/** One workflow row by id, or null. */
export async function findWorkflow(db: Database, workflowId: string): Promise<WorkflowRow | null> {
  const row = await db.select().from(workflows).where(eq(workflows.workflow_id, workflowId)).get();
  return row ?? null;
}
