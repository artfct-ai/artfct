import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { eq } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { workflows } from "./schema";

/** One row of the workflows table. */
export type WorkflowRow = typeof workflows.$inferSelect;

/** Insert a workflow row in status `new`. */
export async function createWorkflow(db: Database, workflowId: string): Promise<void> {
  const timestamp = nowIso();
  await db.insert(workflows).values({
    workflow_id: workflowId,
    status: "new",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

/** Record a new status on a workflow row. The router reads it to drop events on finished workflows. */
export async function setWorkflowStatus(
  db: Database,
  workflowId: string,
  status: WorkflowStatus,
): Promise<void> {
  await db
    .update(workflows)
    .set({ status, updated_at: nowIso() })
    .where(eq(workflows.workflow_id, workflowId));
}

/** One workflow row by id, or null. */
export async function findWorkflow(db: Database, workflowId: string): Promise<WorkflowRow | null> {
  const row = await db.select().from(workflows).where(eq(workflows.workflow_id, workflowId)).get();
  return row ?? null;
}
