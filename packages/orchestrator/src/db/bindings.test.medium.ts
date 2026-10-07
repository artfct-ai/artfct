import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bindWorkflow,
  deleteBindings,
  findBinding,
  listBindings,
  resolveBinding,
  workflowsWithPullsInRepo,
} from "./bindings";
import { createDb } from "./client";

const db = createDb(env.DB);
const issue = { source: "tracker_issue", external_id: "ISS-1" } as const;
const pull = { source: "code_pull", repo: "o/r", number: 1 } as const;

describe("an empty binding table", () => {
  it("lists nothing", async () => {
    expect(await listBindings(db)).toEqual([]);
  });

  it("holds no pull request of a repo", async () => {
    expect(await workflowsWithPullsInRepo(db, "acme/app")).toEqual([]);
  });

  it("finds no binding", async () => {
    expect(await findBinding(db, { source: "code_pull", repo: "acme/app", number: 1 })).toBeNull();
  });
});

describe("bindWorkflow", () => {
  describe("an external object bound to a workflow", () => {
    beforeEach(async () => {
      await bindWorkflow(db, issue, "wf_1");
    });

    it("finds the workflow by the source and the id", async () => {
      expect(await findBinding(db, issue)).toBe("wf_1");
    });

    it("answers null for the same id under another source", async () => {
      expect(await findBinding(db, { source: "chat_thread", external_id: "ISS-1" })).toBeNull();
    });

    it("stores no repository for a source that names none", async () => {
      expect((await listBindings(db)).map((row) => row.repo)).toEqual([null]);
    });

    describe("bound again to the same workflow", () => {
      beforeEach(async () => {
        await bindWorkflow(db, issue, "wf_1");
      });

      it("keeps one row for the one workflow", async () => {
        const rows = await listBindings(db);
        expect(rows.map((row) => row.workflow_id)).toEqual(["wf_1"]);
      });
    });
  });

  describe("a pull request bound again to another workflow", () => {
    beforeEach(async () => {
      await bindWorkflow(db, pull, "wf_1");
      await bindWorkflow(db, pull, "wf_2");
    });

    it("points at the second workflow", async () => {
      expect(await findBinding(db, pull)).toBe("wf_2");
    });

    it("keeps one row", async () => {
      expect(await listBindings(db)).toHaveLength(1);
    });

    it("stores the key and the repository it derived them from", async () => {
      const rows = await listBindings(db);
      expect(rows.map((row) => [row.external_id, row.repo])).toEqual([["o/r#1", "o/r"]]);
    });
  });

  describe("a branch", () => {
    beforeEach(async () => {
      await bindWorkflow(db, { source: "code_branch", repo: "o/r", branch: "artfct/x" }, "wf_1");
    });

    it("stores the branch key and the repository", async () => {
      const rows = await listBindings(db);
      expect(rows.map((row) => [row.external_id, row.repo])).toEqual([["o/r:artfct/x", "o/r"]]);
    });
  });
});

describe("resolveBinding", () => {
  describe("candidates of which the later two are bound", () => {
    beforeEach(async () => {
      await bindWorkflow(db, { source: "chat_thread", external_id: "C1:1.0" }, "wf_slack");
      await bindWorkflow(db, { source: "code_pull", repo: "o/r", number: 9 }, "wf_pr");
    });

    it("answers the first candidate that is bound", async () => {
      const workflowId = await resolveBinding(db, [
        { source: "tracker_issue", external_id: "missing" },
        { source: "code_pull", repo: "o/r", number: 9 },
        { source: "chat_thread", external_id: "C1:1.0" },
      ]);
      expect(workflowId).toBe("wf_pr");
    });
  });

  describe("a candidate nobody bound", () => {
    it("answers null", async () => {
      expect(await resolveBinding(db, [{ source: "documents_page", external_id: "p" }])).toBeNull();
    });
  });
});

describe("deleteBindings", () => {
  describe("two workflows with bindings of several sources", () => {
    beforeEach(async () => {
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 1 }, "wf_1");
      await bindWorkflow(db, { source: "code_branch", repo: "acme/app", branch: "b" }, "wf_1");
      await bindWorkflow(db, { source: "chat_thread", external_id: "C1:1.0" }, "wf_1");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 2 }, "wf_2");
      await deleteBindings(db, "wf_1", ["code_pull", "code_branch"]);
    });

    it("drops only the named sources of the named workflow", async () => {
      const rows = await listBindings(db);
      expect(rows.map((row) => `${row.source}:${row.workflow_id}`).toSorted()).toEqual([
        "chat_thread:wf_1",
        "code_pull:wf_2",
      ]);
    });
  });
});

describe("workflowsWithPullsInRepo", () => {
  describe("pull requests of two repos whose names share a prefix", () => {
    beforeEach(async () => {
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 1 }, "wf_1");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 2 }, "wf_2");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 3 }, "wf_2");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app-two", number: 4 }, "wf_3");
      await bindWorkflow(db, { source: "code_branch", repo: "acme/app", branch: "b" }, "wf_4");
    });

    it("names each workflow of the named repo once", async () => {
      expect((await workflowsWithPullsInRepo(db, "acme/app")).toSorted()).toEqual(["wf_1", "wf_2"]);
    });
  });
});
