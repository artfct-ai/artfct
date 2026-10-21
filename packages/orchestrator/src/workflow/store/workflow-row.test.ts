import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { freshStore } from "../../../test/fresh-store";
import { scenario } from "../../../test/scenario";
import type { WorkflowStore } from "./tasks";
import type { NewConversation, NewWorkflow } from "./workflow-row";

const SESSION: ReplyTarget = {
  source: "tracker",
  session_id: "sess-1",
  issue_id: "issue-1",
  team_id: "team-1",
};
const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };

const OPENED: NewConversation = {
  conversation_id: "wf_row",
  request_title: "Fix the login redirect",
  request_text: "Fix the login redirect.",
  request_links: [],
  origin: SESSION,
};

const PLANNED: NewWorkflow = {
  workflow_id: "wf_first",
  definition: "development",
  name: "Login redirect",
  reason: "asked",
  repo: "acme/app",
  subject: { kind: "issue", issue_id: "issue-1" },
};

const opened = scenario(freshStore, (store) => {
  store.openConversation(OPENED);
});

const created = scenario(opened, (store) => {
  store.createWorkflow(PLANNED);
});

describe("a store before the conversation opens", () => {
  it("holds no conversation and no workflow", () =>
    freshStore((store) => {
      expect([store.conversation(), store.workflowRow()]).toEqual([null, null]);
    }));

  it("refuses a read that needs the conversation", () =>
    freshStore((store) => {
      expect(() => store.requireConversation()).toThrow("the conversation is not opened");
    }));
});

describe("an opened conversation", () => {
  it("holds no workflow, stage plan, subject or end", () =>
    opened((store) => {
      expect(store.workflowRow()).toBeNull();
      expect(store.activeWorkflow()).toBeNull();
      expect(store.stagePlan()).toBeNull();
      expect(store.subject()).toBeNull();
      expect(store.workflowEnd()).toBeNull();
      expect(store.workflowFinished()).toBe(false);
    }));

  it("refuses a read that needs the workflow", () =>
    opened((store) => {
      expect(() => store.requireWorkflowRow()).toThrow("the conversation has no workflow");
    }));

  it("replies to its origin first", () =>
    opened((store) => {
      expect(store.replyTargets()).toEqual([SESSION]);
    }));

  it("is named by its request title", () =>
    opened((store) => {
      expect(store.workflowName()).toBe("Fix the login redirect");
    }));

  it("counts no task and no job", () =>
    opened((store) => {
      expect(store.taskCount()).toBe(0);
      expect(store.jobCount()).toBe(0);
    }));
});

describe("a workflow a plan created", () => {
  it("runs as the active workflow, without a stage plan or an end", () =>
    created((store) => {
      expect(store.activeWorkflow()).toMatchObject({ workflow_id: "wf_first", status: "running" });
      expect(store.stagePlan()).toBeNull();
      expect(store.workflowEnd()).toBeNull();
    }));

  it("keeps its subject", () =>
    created((store) => {
      expect(store.subject()).toEqual({ kind: "issue", issue_id: "issue-1" });
    }));

  it("is named by its plan", () =>
    created((store) => {
      expect(store.workflowName()).toBe("Login redirect");
    }));

  it("takes a later plan's name, reason and repository", () =>
    created((store) => {
      store.updateWorkflow({ name: "Login fix", reason: "renamed", repo: null });
      expect(store.requireWorkflowRow()).toMatchObject({
        definition: "development",
        name: "Login fix",
        reason: "renamed",
        repo: null,
      });
    }));
});

describe("a workflow after the one that ended", () => {
  const next = scenario(created, (store) => {
    store.writeStagePlan({
      stages: ["implement"],
      job_slots: 2,
      page_parent: null,
      root_page: null,
    });
    store.startWorkflowEnd({ ends_as: "done", reason: "Merged.", answering: [], posted: true });
    store.updateWorkflow({ status: "ended" });
    store.createWorkflow({ ...PLANNED, workflow_id: "wf_second", name: "Docs", subject: null });
  });

  it("is the active workflow", () =>
    next((store) => {
      expect(store.activeWorkflow()?.workflow_id).toBe("wf_second");
      expect(store.workflowName()).toBe("Docs");
    }));

  it("starts without the stage plan, the subject or the end of the one before", () =>
    next((store) => {
      expect([store.stagePlan(), store.subject(), store.workflowEnd()]).toEqual([null, null, null]);
    }));
});

describe("the last workflow once it ended", () => {
  const ended = scenario(created, (store) => {
    store.startWorkflowEnd({ ends_as: "done", reason: "Merged.", answering: [], posted: true });
    store.updateWorkflow({ status: "ended" });
  });

  it("is not active but stays the workflow every reader sees", () =>
    ended((store) => {
      expect(store.activeWorkflow()).toBeNull();
      expect(store.workflowRow()?.workflow_id).toBe("wf_first");
      expect(store.workflowFinished()).toBe(true);
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
    store.startWorkflowEnd({ ends_as: "done", reason: "Merged.", answering: [], posted: false });
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

  it("moves the workflow to ending, which shows the status it ends as", () =>
    ending((store) => {
      expect(store.requireWorkflowRow().status).toBe("ending");
      expect(store.workflowStatus()).toBe("done");
    }));

  it("records its post", () =>
    ending((store) => {
      store.markWorkflowEndPosted();
      expect(store.workflowEnd()?.posted).toBe(true);
    }));

  it("stays once the workflow ended", () =>
    ending((store) => {
      store.updateWorkflow({ status: "ended" });
      expect(store.workflowEnd()?.reason).toBe("Merged.");
      expect(store.workflowStatus()).toBe("done");
    }));
});
