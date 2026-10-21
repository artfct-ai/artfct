import { eq } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { workflows } from "./schema";

/** One row of the workflows table. */
export type WorkflowRow = typeof workflows.$inferSelect;

/** What a conversation writes to the router's row of one of its workflows. */
export type WorkflowRecord = Pick<WorkflowRow, "workflow_id" | "conversation_id" | "status">;

/**
 * Write the router's row of a workflow with its current status. The first write inserts it, and
 * every later one, such as a restart's write again, sets the status.
 */
export async function writeWorkflowRow(db: Database, record: WorkflowRecord): Promise<void> {
  const timestamp = nowIso();
  await db
    .insert(workflows)
    .values({ ...record, created_at: timestamp, updated_at: timestamp })
    .onConflictDoUpdate({
      target: workflows.workflow_id,
      set: { status: record.status, updated_at: timestamp },
    });
}

/** One workflow row by id, or null. */
export async function findWorkflow(db: Database, workflowId: string): Promise<WorkflowRow | null> {
  const row = await db.select().from(workflows).where(eq(workflows.workflow_id, workflowId)).get();
  return row ?? null;
}
