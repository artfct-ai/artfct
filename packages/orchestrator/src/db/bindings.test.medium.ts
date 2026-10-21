import type { Binding } from "@artfct-ai/contracts/sources";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bindWorkflow,
  claimBinding,
  conversationsWithPullsInRepo,
  deleteBindings,
  findBinding,
  findBoundConversation,
  listBindings,
} from "./bindings";
import { createDb } from "./client";
import { writeWorkflowRow } from "./workflows";

const db = createDb(env.DB);
const issue = { source: "tracker_issue", external_id: "ISS-1" } as const;
const page = { source: "documents_page", external_id: "page-1" } as const;
const pull = { source: "code_pull", repo: "o/r", number: 1 } as const;

async function seed(binding: Binding, workflowId: string): Promise<void> {
  await claimBinding(db, binding, { previous: null, workflowId });
}

async function seedWorkflow(
  workflowId: string,
  conversationId: string,
  status: WorkflowStatus = "running",
): Promise<void> {
  await writeWorkflowRow(db, { workflow_id: workflowId, conversation_id: conversationId, status });
}

describe("an empty binding table", () => {
  it("lists nothing", async () => {
    expect(await listBindings(db)).toEqual([]);
  });

  it("holds no pull request of a repo", async () => {
    expect(await conversationsWithPullsInRepo(db, "acme/app")).toEqual([]);
  });

  it("finds no binding", async () => {
    expect(await findBinding(db, { source: "code_pull", repo: "acme/app", number: 1 })).toBeNull();
  });

  it("leads to no conversation", async () => {
    expect(await findBoundConversation(db, [issue, pull])).toBeNull();
  });
});

describe("bindWorkflow", () => {
  beforeEach(async () => {
    await seedWorkflow("wf_1", "cv_1");
    await seedWorkflow("wf_2", "cv_2");
  });

  describe("an object bound to a workflow", () => {
    beforeEach(async () => {
      await bindWorkflow(db, issue, "wf_1");
    });

    it("finds the workflow by the source and the id", async () => {
      expect(await findBinding(db, issue)).toBe("wf_1");
    });

    it("answers null for the same id under another source", async () => {
      expect(await findBinding(db, { source: "documents_page", external_id: "ISS-1" })).toBeNull();
    });

    it("lists it with its workflow's conversation and without a repository", async () => {
      const rows = await listBindings(db);
      expect(rows.map((row) => [row.workflow_id, row.conversation_id, row.repo])).toEqual([
        ["wf_1", "cv_1", null],
      ]);
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
      await seedWorkflow("wf_1", "cv_1", "done");
      await bindWorkflow(db, pull, "wf_1");
    });

    it("binds nothing", async () => {
      expect(await findBinding(db, pull)).toBeNull();
    });
  });

  describe("a pull request of a workflow that ended after it bound it", () => {
    beforeEach(async () => {
      await bindWorkflow(db, pull, "wf_2");
      await seedWorkflow("wf_1", "cv_1", "failed");
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
      won = await claimBinding(db, issue, { previous: null, workflowId: "wf_first" });
    });

    it("is claimed", () => {
      expect(won).toBe(true);
    });

    it("points at the claiming workflow", async () => {
      expect(await findBinding(db, issue)).toBe("wf_first");
    });

    describe("and a second claim that also found it unbound", () => {
      beforeEach(async () => {
        won = await claimBinding(db, issue, { previous: null, workflowId: "wf_second" });
      });

      it("loses", () => {
        expect(won).toBe(false);
      });

      it("leaves it with the first", async () => {
        expect(await findBinding(db, issue)).toBe("wf_first");
      });
    });
  });

  describe("a binding of an ended workflow", () => {
    beforeEach(async () => {
      await seed(issue, "wf_ended");
    });

    it("moves to a claim that found it there", async () => {
      const previous = "wf_ended";
      expect(await claimBinding(db, issue, { previous, workflowId: "wf_next" })).toBe(true);
      expect(await findBinding(db, issue)).toBe("wf_next");
    });

    it("stays with a claim that found it somewhere else", async () => {
      const previous = "wf_other";
      expect(await claimBinding(db, issue, { previous, workflowId: "wf_next" })).toBe(false);
      expect(await findBinding(db, issue)).toBe("wf_ended");
    });
  });
});

describe("deleteBindings", () => {
  describe("two workflows with bindings of several sources", () => {
    beforeEach(async () => {
      await seedWorkflow("wf_1", "cv_1");
      await seedWorkflow("wf_2", "cv_2");
      await seed({ source: "code_pull", repo: "acme/app", number: 1 }, "wf_1");
      await seed({ source: "code_branch", repo: "acme/app", branch: "b" }, "wf_1");
      await seed(issue, "wf_1");
      await seed(page, "wf_1");
      await seed({ source: "code_pull", repo: "acme/app", number: 2 }, "wf_2");
      await deleteBindings(db, "wf_1");
    });

    it("drops every binding of the named workflow and only those", async () => {
      const rows = await listBindings(db);
      expect(rows.map((row) => `${row.source}:${row.workflow_id}`)).toEqual(["code_pull:wf_2"]);
    });
  });
});

describe("findBoundConversation", () => {
  beforeEach(async () => {
    await seedWorkflow("wf_running", "cv_running");
    await seedWorkflow("wf_waiting", "cv_waiting", "waiting_input");
    await seedWorkflow("wf_ended", "cv_ended", "cancelled");
  });

  describe("an object bound to a running workflow", () => {
    beforeEach(async () => {
      await seed(issue, "wf_running");
    });

    it("leads to that workflow's conversation", async () => {
      expect(await findBoundConversation(db, [issue])).toBe("cv_running");
    });
  });

  describe("an object bound to a workflow that waits for input", () => {
    beforeEach(async () => {
      await seed(issue, "wf_waiting");
    });

    it("leads to that workflow's conversation", async () => {
      expect(await findBoundConversation(db, [issue])).toBe("cv_waiting");
    });
  });

  describe("an object whose workflow ended before its end removed the binding", () => {
    beforeEach(async () => {
      await seed(issue, "wf_ended");
    });

    it("leads nowhere", async () => {
      expect(await findBoundConversation(db, [issue])).toBeNull();
    });
  });

  describe("an object bound to a workflow without a row", () => {
    beforeEach(async () => {
      await seed(issue, "wf_unknown");
    });

    it("leads nowhere", async () => {
      expect(await findBoundConversation(db, [issue])).toBeNull();
    });
  });

  describe("two objects bound to two running workflows", () => {
    beforeEach(async () => {
      await seed(issue, "wf_waiting");
      await seed(pull, "wf_running");
    });

    it("follows the first object in the event's order", async () => {
      expect(await findBoundConversation(db, [pull, issue])).toBe("cv_running");
      expect(await findBoundConversation(db, [issue, pull])).toBe("cv_waiting");
    });
  });

  describe("an ended workflow's object before a running workflow's object", () => {
    beforeEach(async () => {
      await seed(issue, "wf_ended");
      await seed(pull, "wf_running");
    });

    it("skips the ended one", async () => {
      expect(await findBoundConversation(db, [issue, pull])).toBe("cv_running");
    });
  });
});

describe("conversationsWithPullsInRepo", () => {
  describe("pull requests of two repos whose names share a prefix", () => {
    beforeEach(async () => {
      await seedWorkflow("wf_1", "cv_1");
      await seedWorkflow("wf_2", "cv_2");
      await seedWorkflow("wf_3", "cv_3");
      await seedWorkflow("wf_4", "cv_4");
      await seedWorkflow("wf_5", "cv_5", "done");
      await seed({ source: "code_pull", repo: "acme/app", number: 1 }, "wf_1");
      await seed({ source: "code_pull", repo: "acme/app", number: 2 }, "wf_2");
      await seed({ source: "code_pull", repo: "acme/app", number: 3 }, "wf_2");
      await seed({ source: "code_pull", repo: "acme/app-two", number: 4 }, "wf_3");
      await seed({ source: "code_branch", repo: "acme/app", branch: "b" }, "wf_4");
      await seed({ source: "code_pull", repo: "acme/app", number: 5 }, "wf_5");
    });

    it("names the conversation of each running workflow of the named repo once", async () => {
      expect((await conversationsWithPullsInRepo(db, "acme/app")).toSorted()).toEqual([
        "cv_1",
        "cv_2",
      ]);
    });
  });
});
