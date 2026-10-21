import type { Binding } from "@artfct-ai/contracts/sources";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abandonWorkflowCreate,
  bindWorkflow,
  claimBinding,
  claimBindingAndRecordPredecessor,
  deleteBindings,
  findBinding,
  listBindings,
  takeOverWorkflowCreate,
  workflowsWithPullsInRepo,
} from "./bindings";
import { createDb } from "./client";
import { createWorkflow, findWorkflow, setWorkflowStatus } from "./workflows";

const db = createDb(env.DB);
const issue = { source: "tracker_issue", external_id: "ISS-1" } as const;
const pull = { source: "code_pull", repo: "o/r", number: 1 } as const;
const thread = { source: "chat_thread", external_id: "C1:1.0" } as const;

async function seed(binding: Binding, workflowId: string): Promise<void> {
  await claimBinding(db, binding, { previous: null, workflowId });
}

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
  beforeEach(async () => {
    await createWorkflow(db, "wf_1");
    await createWorkflow(db, "wf_2");
  });

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

  describe("a workflow whose row ended", () => {
    beforeEach(async () => {
      await setWorkflowStatus(db, "wf_1", "done");
      await bindWorkflow(db, pull, "wf_1");
    });

    it("binds nothing", async () => {
      expect(await findBinding(db, pull)).toBeNull();
    });
  });

  describe("a pull request of a workflow that ended after it bound it", () => {
    beforeEach(async () => {
      await bindWorkflow(db, pull, "wf_2");
      await setWorkflowStatus(db, "wf_1", "failed");
      await bindWorkflow(db, pull, "wf_1");
    });

    it("keeps pointing at the workflow that bound it", async () => {
      expect(await findBinding(db, pull)).toBe("wf_2");
    });
  });

  describe("a workflow without a row", () => {
    beforeEach(async () => {
      await bindWorkflow(db, pull, "wf_unknown");
    });

    it("binds nothing", async () => {
      expect(await findBinding(db, pull)).toBeNull();
    });
  });
});

describe("claimBinding", () => {
  describe("a binding nobody bound", () => {
    let won: boolean;

    beforeEach(async () => {
      won = await claimBinding(db, thread, { previous: null, workflowId: "wf_first" });
    });

    it("is claimed", () => {
      expect(won).toBe(true);
    });

    it("points at the claiming workflow", async () => {
      expect(await findBinding(db, thread)).toBe("wf_first");
    });

    describe("and a second claim that also found it unbound", () => {
      beforeEach(async () => {
        won = await claimBinding(db, thread, { previous: null, workflowId: "wf_second" });
      });

      it("loses", () => {
        expect(won).toBe(false);
      });

      it("leaves it with the first", async () => {
        expect(await findBinding(db, thread)).toBe("wf_first");
      });
    });
  });

  describe("a binding of an ended workflow", () => {
    beforeEach(async () => {
      await seed(thread, "wf_ended");
    });

    it("moves to a claim that found it there", async () => {
      const previous = "wf_ended";
      expect(await claimBinding(db, thread, { previous, workflowId: "wf_next" })).toBe(true);
      expect(await findBinding(db, thread)).toBe("wf_next");
    });

    it("stays with a claim that found it somewhere else", async () => {
      const previous = "wf_other";
      expect(await claimBinding(db, thread, { previous, workflowId: "wf_next" })).toBe(false);
      expect(await findBinding(db, thread)).toBe("wf_ended");
    });
  });
});

describe("deleteBindings", () => {
  describe("two workflows with bindings of several sources", () => {
    beforeEach(async () => {
      await seed({ source: "code_pull", repo: "acme/app", number: 1 }, "wf_1");
      await seed({ source: "code_branch", repo: "acme/app", branch: "b" }, "wf_1");
      await seed({ source: "chat_thread", external_id: "C1:1.0" }, "wf_1");
      await seed({ source: "code_pull", repo: "acme/app", number: 2 }, "wf_2");
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

describe("claimBindingAndRecordPredecessor", () => {
  beforeEach(async () => {
    await seed(thread, "wf_ended");
  });

  describe("a claim that wins", () => {
    let won: boolean;

    beforeEach(async () => {
      const claim = { previous: "wf_ended", workflowId: "wf_next", predecessorId: "wf_ended" };
      won = await claimBindingAndRecordPredecessor(db, thread, claim);
      await createWorkflow(db, "wf_next");
    });

    it("moves the binding", async () => {
      expect(won).toBe(true);
      expect(await findBinding(db, thread)).toBe("wf_next");
    });

    it("records the predecessor, which a takeover reads", async () => {
      expect(await takeOverWorkflowCreate(db, thread, "wf_next")).toEqual({
        predecessorId: "wf_ended",
      });
    });
  });

  describe("a claim that lost", () => {
    beforeEach(async () => {
      await claimBinding(db, thread, { previous: "wf_ended", workflowId: "wf_other" });
    });

    it("records no predecessor", async () => {
      const claim = { previous: "wf_ended", workflowId: "wf_next", predecessorId: "wf_ended" };
      expect(await claimBindingAndRecordPredecessor(db, thread, claim)).toBe(false);
      await seed(issue, "wf_next");
      expect(await takeOverWorkflowCreate(db, issue, "wf_next")).toEqual({ predecessorId: null });
    });
  });
});

describe("abandonWorkflowCreate", () => {
  beforeEach(async () => {
    await seed(thread, "wf_ended");
    await claimBinding(db, thread, { previous: "wf_ended", workflowId: "wf_1" });
    await seed(issue, "wf_1");
    await createWorkflow(db, "wf_1");
  });

  const won = [
    { binding: thread, previous: "wf_ended" },
    { binding: issue, previous: null },
  ];

  describe("a workflow whose row is new", () => {
    beforeEach(async () => {
      await abandonWorkflowCreate(db, "wf_1", won);
    });

    it("points each binding back where it pointed", async () => {
      expect(await findBinding(db, thread)).toBe("wf_ended");
      expect(await findBinding(db, issue)).toBeNull();
    });

    it("marks the row failed", async () => {
      expect((await findWorkflow(db, "wf_1"))?.status).toBe("failed");
    });
  });

  describe("a workflow whose create a takeover marked running", () => {
    beforeEach(async () => {
      await setWorkflowStatus(db, "wf_1", "running");
      await abandonWorkflowCreate(db, "wf_1", won);
    });

    it("keeps its bindings", async () => {
      expect(await findBinding(db, thread)).toBe("wf_1");
      expect(await findBinding(db, issue)).toBe("wf_1");
    });

    it("keeps the row running", async () => {
      expect((await findWorkflow(db, "wf_1"))?.status).toBe("running");
    });
  });
});

describe("takeOverWorkflowCreate", () => {
  describe("a binding whose workflow has no row", () => {
    beforeEach(async () => {
      await seed(thread, "wf_1");
    });

    it("inserts the row running", async () => {
      expect(await takeOverWorkflowCreate(db, thread, "wf_1")).toEqual({ predecessorId: null });
      expect((await findWorkflow(db, "wf_1"))?.status).toBe("running");
    });
  });

  describe("a binding whose workflow row is new", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_1");
      await seed(thread, "wf_1");
    });

    it("marks the row running", async () => {
      expect(await takeOverWorkflowCreate(db, thread, "wf_1")).toEqual({ predecessorId: null });
      expect((await findWorkflow(db, "wf_1"))?.status).toBe("running");
    });
  });

  describe("a binding that moved to another workflow", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_1");
      await seed(thread, "wf_2");
    });

    it("refuses and leaves the row new", async () => {
      expect(await takeOverWorkflowCreate(db, thread, "wf_1")).toBeNull();
      expect((await findWorkflow(db, "wf_1"))?.status).toBe("new");
    });
  });

  describe("a workflow an abandon marked failed", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_1");
      await seed(thread, "wf_1");
      await setWorkflowStatus(db, "wf_1", "failed");
    });

    it("refuses and leaves the row failed", async () => {
      expect(await takeOverWorkflowCreate(db, thread, "wf_1")).toBeNull();
      expect((await findWorkflow(db, "wf_1"))?.status).toBe("failed");
    });
  });
});

describe("workflowsWithPullsInRepo", () => {
  describe("pull requests of two repos whose names share a prefix", () => {
    beforeEach(async () => {
      await seed({ source: "code_pull", repo: "acme/app", number: 1 }, "wf_1");
      await seed({ source: "code_pull", repo: "acme/app", number: 2 }, "wf_2");
      await seed({ source: "code_pull", repo: "acme/app", number: 3 }, "wf_2");
      await seed({ source: "code_pull", repo: "acme/app-two", number: 4 }, "wf_3");
      await seed({ source: "code_branch", repo: "acme/app", branch: "b" }, "wf_4");
    });

    it("names each workflow of the named repo once", async () => {
      expect((await workflowsWithPullsInRepo(db, "acme/app")).toSorted()).toEqual(["wf_1", "wf_2"]);
    });
  });
});
