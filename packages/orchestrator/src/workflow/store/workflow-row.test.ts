import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { freshStore } from "../../../test/fresh-store";
import { scenario } from "../../../test/scenario";
import type { WorkflowStore } from "./tasks";
import type { NewWorkflow } from "./workflow-row";

const SESSION: ReplyTarget = {
  source: "tracker",
  session_id: "sess-1",
  issue_id: "issue-1",
  team_id: "team-1",
};
const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };

const CREATED: NewWorkflow = {
  workflow_id: "wf_row",
  request_title: "Fix the login redirect",
  request_text: "Fix the login redirect.",
  request_links: [],
  origin: SESSION,
  subject: { kind: "issue", issue_id: "issue-1" },
};

const created = scenario(freshStore, (store) => {
  store.createWorkflow(CREATED);
});

describe("a store before the create", () => {
  it("holds no workflow", () =>
    freshStore((store) => {
      expect(store.workflowRow()).toBeNull();
    }));

  it("refuses a read that needs the workflow", () =>
    freshStore((store) => {
      expect(() => store.requireWorkflowRow()).toThrow("the workflow is not created");
    }));
});

describe("a created workflow", () => {
  it("is new, without a plan, a stage plan or an end", () =>
    created((store) => {
      expect(store.requireWorkflowRow().status).toBe("new");
      expect(store.plan()).toBeNull();
      expect(store.stagePlan()).toBeNull();
      expect(store.workflowEnd()).toBeNull();
    }));

  it("keeps its subject", () =>
    created((store) => {
      expect(store.subject()).toEqual({ kind: "issue", issue_id: "issue-1" });
    }));

  it("replies to its origin first", () =>
    created((store) => {
      expect(store.replyTargets()).toEqual([SESSION]);
    }));

  it("is named by its request title", () =>
    created((store) => {
      expect(store.workflowName()).toBe("Fix the login redirect");
    }));

  it("counts no task and no job", () =>
    created((store) => {
      expect(store.taskCount()).toBe(0);
      expect(store.jobCount()).toBe(0);
    }));
});

describe("a workflow whose plan names it", () => {
  const named = scenario(created, (store) => {
    store.writePlan({
      definition: "development",
      name: "Login redirect",
      reason: "asked",
      repo: "acme/app",
    });
  });

  it("is named by its plan", () =>
    named((store) => {
      expect(store.workflowName()).toBe("Login redirect");
    }));

  it("takes a later plan whole", () =>
    named((store) => {
      store.writePlan({
        definition: "development",
        name: "Login fix",
        reason: "renamed",
        repo: null,
      });
      expect(store.plan()).toEqual({
        definition: "development",
        name: "Login fix",
        reason: "renamed",
        repo: null,
      });
    }));
});

describe("a workflow whose plan names stages", () => {
  const planned = scenario(created, (store) => {
    store.writeStagePlan({
      stages: ["implement"],
      job_slots: 2,
      page_parent: null,
      root_page: null,
    });
  });

  it("takes a later stage plan whole", () =>
    planned((store) => {
      store.writeStagePlan({
        stages: ["design", "implement"],
        job_slots: 1,
        page_parent: "project-1",
        root_page: null,
      });
      expect(store.stagePlan()).toEqual({
        stages: ["design", "implement"],
        job_slots: 1,
        page_parent: "project-1",
        root_page: null,
      });
    }));
});

describe("a reply target that joins", () => {
  it("adds a new place after the origin", () =>
    created((store) => {
      expect(store.addReplyTarget(THREAD)).toBe(true);
      expect(store.replyTargets()).toEqual([SESSION, THREAD]);
    }));

  it("counts a tracker session once whatever its issue fields", () =>
    created((store: WorkflowStore) => {
      expect(store.addReplyTarget({ ...SESSION, issue_id: "issue-2", team_id: "team-2" })).toBe(
        false,
      );
      expect(store.replyTargets()).toEqual([SESSION]);
    }));

  it("counts a chat thread once", () =>
    created((store) => {
      store.addReplyTarget(THREAD);
      expect(store.addReplyTarget({ ...THREAD })).toBe(false);
      expect(store.replyTargets()).toEqual([SESSION, THREAD]);
    }));
});

describe("a workflow end", () => {
  const ending = scenario(created, (store) => {
    store.recordWorkflowEnd({ ends_as: "done", reason: "Merged.", answering: [], posted: false });
  });

  it("is recorded unposted", () =>
    ending((store) => {
      expect(store.workflowEnd()).toEqual({
        ends_as: "done",
        reason: "Merged.",
        answering: [],
        posted: false,
      });
    }));

  it("records its post", () =>
    ending((store) => {
      store.markWorkflowEndPosted();
      expect(store.workflowEnd()?.posted).toBe(true);
    }));

  it("is gone once it finished", () =>
    ending((store) => {
      store.clearWorkflowEnd();
      expect(store.workflowEnd()).toBeNull();
    }));
});
