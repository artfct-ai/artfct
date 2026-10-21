import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { workflows } from "./schema";
import { findWorkflow, writeWorkflowRow, type WorkflowRow } from "./workflows";

const db = createDb(env.DB);

const RUNNING = { workflow_id: "wf_1", conversation_id: "cv_1", status: "running" } as const;

describe("workflows", () => {
  describe("a workflow row written once", () => {
    let row: WorkflowRow | null;
    beforeEach(async () => {
      await writeWorkflowRow(db, RUNNING);
      row = await findWorkflow(db, "wf_1");
    });

    it("holds the conversation and the status", () => {
      expect(row).toMatchObject({ conversation_id: "cv_1", status: "running" });
    });

    it("stamps created_at and updated_at together", () => {
      expect(row?.created_at).toBe(row?.updated_at);
    });

    describe("written again with a new status", () => {
      beforeEach(async () => {
        await writeWorkflowRow(db, { ...RUNNING, status: "done" });
        row = await findWorkflow(db, "wf_1");
      });

      it("reports the new status", () => {
        expect(row?.status).toBe("done");
      });

      it("moves updated_at to or past created_at", () => {
        expect(row?.updated_at.localeCompare(row.created_at)).toBeGreaterThanOrEqual(0);
      });
    });

    describe("written again with the same status, as a restart does", () => {
      beforeEach(async () => {
        await writeWorkflowRow(db, RUNNING);
      });

      it("keeps one row", async () => {
        expect(await db.select().from(workflows)).toHaveLength(1);
      });
    });
  });

  describe("a workflow nobody wrote", () => {
    it("is not found", async () => {
      expect(await findWorkflow(db, "wf_missing")).toBeNull();
    });
  });
});
