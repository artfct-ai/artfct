import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { createWorkflow, findWorkflow, setWorkflowStatus, type WorkflowRow } from "./workflows";

const db = createDb(env.DB);

describe("workflows", () => {
  describe("a created workflow", () => {
    let row: WorkflowRow | null;
    beforeEach(async () => {
      await createWorkflow(db, "wf_1");
      row = await findWorkflow(db, "wf_1");
    });

    it("starts in status new", () => {
      expect(row?.status).toBe("new");
    });

    it("stamps created_at and updated_at together", () => {
      expect(row?.created_at).toBe(row?.updated_at);
    });

    describe("after a status change", () => {
      beforeEach(async () => {
        await setWorkflowStatus(db, "wf_1", "done");
        row = await findWorkflow(db, "wf_1");
      });

      it("reports the new status", () => {
        expect(row?.status).toBe("done");
      });

      it("moves updated_at to or past created_at", () => {
        expect(row?.updated_at.localeCompare(row.created_at)).toBeGreaterThanOrEqual(0);
      });
    });

    describe("created a second time under the same id", () => {
      let failure: unknown;
      beforeEach(async () => {
        failure = await createWorkflow(db, "wf_1").then(
          () => null,
          (reason: unknown) => reason,
        );
      });

      it("refuses the second row", () => {
        expect(failure).toBeInstanceOf(Error);
      });

      it("keeps the status of the first", async () => {
        expect((await findWorkflow(db, "wf_1"))?.status).toBe("new");
      });
    });
  });

  describe("a workflow nobody created", () => {
    it("is not found", async () => {
      expect(await findWorkflow(db, "wf_missing")).toBeNull();
    });

    it("takes a status update without an error", async () => {
      await expect(setWorkflowStatus(db, "wf_missing", "done")).resolves.toBeUndefined();
    });

    it("is still not found after that update", async () => {
      await setWorkflowStatus(db, "wf_missing", "done");
      expect(await findWorkflow(db, "wf_missing")).toBeNull();
    });
  });
});
