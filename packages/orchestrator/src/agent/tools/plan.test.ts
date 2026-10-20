import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "bun:test";
import { freshRuntime, unstartedRuntime } from "../../../test/fresh-runtime";
import {
  patchModelAuthors,
  fakeDocumentsOf,
  patchNestingHost,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { planTools } from "./plan";
import { startTools } from "./start/start";

const call = { toolCallId: "call-1", messages: [], context: {} };

const TRACKER_ORIGIN = {
  source: "tracker",
  session_id: "s1",
  issue_id: "i1",
  team_id: "team-1",
} as const;

const THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;

async function planWithPages(
  workflow: FakeRuntime,
  fields: {
    stages: string[];
    page_parent?: string | null;
    root_page?: string | null;
    subject?: string;
  },
): Promise<string> {
  const { set_plan } = planTools(workflow);
  return toolText(
    await set_plan.execute(
      {
        name: "Ship it",
        definition: "development",
        repo: "acme/app",
        reason: "test",
        page_parent: null,
        ...fields,
      },
      call,
    ),
  );
}

function addPlanStage(workflow: FakeRuntime): void {
  const [design, ...rest] = workflow.workflowDefinition().stages;
  if (!design) throw new Error("the test definition has no design stage");
  workflow.patchWorkflowDefinition({
    stages: [design, { ...design, name: "plan" }, ...rest],
  });
}

describe("set_plan", () => {
  describe("on a workflow that is done", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      workflow.store.updateWorkflow({ status: "done" });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Ship it",
            definition: "development",
            stages: ["design"],
            repo: null,
            page_parent: null,
            reason: "more",
          },
          call,
        ),
      );
    });

    it("refuses, since a finished workflow stays finished", () =>
      refused(() => {
        expect(result).toBe("The workflow is done. A finished workflow stays finished.");
      }));

    it("stays done with no plan", () =>
      refused((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("done");
        expect(workflow.store.stagePlan()).toBeNull();
      }));
  });

  describe("a workflow definition the deployment does not hold", () => {
    let result: string;
    const named = scenario(unstartedRuntime, async (workflow) => {
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute({ name: "Ship it", definition: "incident", reason: "x" }, call),
      );
    });

    it("lists the workflow definitions the deployment holds", () =>
      named(() => {
        expect(result).toBe(
          "Unknown workflow definition incident. The deployment holds: development.",
        );
      }));

    it("does not start the workflow", () =>
      named((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("new");
        expect(workflow.store.plan()).toBeNull();
      }));
  });

  describe("a first plan that names a second workflow definition", () => {
    const incident = scenario(unstartedRuntime, (workflow) => {
      const [, , implement] = workflow.workflowDefinitions()[0]?.stages ?? [];
      if (!implement) throw new Error("the test definition has no implement stage");
      workflow.addWorkflowDefinition({
        name: "incident",
        description: "Fix an incident.",
        documents: {},
        stages: [implement],
      });
    });

    it("names a stage the workflow definition does not hold", () =>
      incident(async (workflow) => {
        const { set_plan } = planTools(workflow);
        expect(
          await set_plan.execute(
            {
              name: "Fix it",
              definition: "incident",
              stages: ["design"],
              repo: null,
              page_parent: null,
              reason: "x",
            },
            call,
          ),
        ).toBe("Unknown stages: design. Use names from workflow definition incident.");
        expect(workflow.store.plan()).toBeNull();
      }));
  });

  describe("a later plan that names another workflow definition", () => {
    let result: string;
    const renamed = scenario(freshRuntime, async (workflow) => {
      workflow.addWorkflowDefinition({ ...workflow.workflowDefinition(), name: "incident" });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Ship it",
            definition: "incident",
            stages: ["design"],
            repo: null,
            page_parent: null,
            reason: "x",
          },
          call,
        ),
      );
    });

    it("names the workflow definition the workflow keeps", () =>
      renamed(() => {
        expect(result).toBe(
          "The workflow runs workflow definition development, and a plan cannot change it. Call set_plan with definition development.",
        );
      }));

    it("keeps the workflow definition and does not plan the stages", () =>
      renamed((workflow) => {
        expect(workflow.store.plan()?.definition).toBe("development");
        expect(workflow.store.stagePlan()).toBeNull();
      }));
  });

  describe("a later plan without stages", () => {
    it("asks for the stages", () =>
      freshRuntime(async (workflow) => {
        const { set_plan } = planTools(workflow);
        expect(
          await set_plan.execute({ name: "Ship it", definition: "development", reason: "x" }, call),
        ).toBe(
          "The workflow already started from workflow definition development. Call set_plan again with the stages.",
        );
      }));
  });

  describe("stages the config does not name", () => {
    let result: string;
    const planned = scenario(freshRuntime, async (workflow) => {
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Ship it",
            definition: "development",
            stages: ["design", "deploy", "ship"],
            repo: null,
            page_parent: null,
            reason: "test",
          },
          call,
        ),
      );
    });

    it("names every stage it does not know", () =>
      planned(() => {
        expect(result).toBe(
          "Unknown stages: deploy, ship. Use names from workflow definition development.",
        );
      }));

    it("plans no stages", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()).toBeNull();
      }));
  });

  describe("a stage that needs a repository, with no repository", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Ship it",
            definition: "development",
            stages: ["design", "implement"],
            repo: null,
            page_parent: null,
            reason: "test",
          },
          call,
        ),
      );
    });

    it("says a planned stage needs a repository", () =>
      refused(() => {
        expect(result).toMatch(/^A planned stage needs a repository/);
      }));

    it("plans no stages", () =>
      refused((workflow) => {
        expect(workflow.store.stagePlan()).toBeNull();
      }));

    describe("and a second call with stages that need no repository", () => {
      const documentsPlan = scenario(refused, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(
          await set_plan.execute(
            {
              name: "Write the design",
              definition: "development",
              stages: ["design"],
              repo: null,
              page_parent: null,
              reason: "docs",
            },
            call,
          ),
        );
      });

      it("answers with the stages and the job limit", () =>
        documentsPlan(() => {
          expect(result).toBe(
            "Plan set: design, up to 100 jobs at once. Call start_job with stage design and a brief for it.",
          );
        }));

      it("stores the plan without a repository", () =>
        documentsPlan((workflow) => {
          expect(workflow.store.requireWorkflowRow().status).toBe("running");
          expect(workflow.store.plan()?.reason).toBe("docs");
          expect(workflow.store.stagePlan()).toMatchObject({ stages: ["design"], repo: null });
        }));
    });
  });

  describe("a stage whose author writes its page as a model call, with no page parent", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      patchModelAuthors(workflow);
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Ship it",
            definition: "development",
            stages: ["design"],
            repo: null,
            page_parent: null,
            reason: "test",
          },
          call,
        ),
      );
    });

    it("says a planned stage needs a page parent", () =>
      refused(() => {
        expect(result).toMatch(/^A planned stage writes its page as a model call/);
      }));

    it("plans no stages", () =>
      refused((workflow) => {
        expect(workflow.store.stagePlan()).toBeNull();
      }));

    describe("and a second call that names one", () => {
      const planned = scenario(refused, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(
          await set_plan.execute(
            {
              name: "Ship it",
              definition: "development",
              stages: ["design"],
              repo: null,
              page_parent: "page-1",
              reason: "test",
            },
            call,
          ),
        );
      });

      it("answers that the plan is set", () =>
        planned(() => {
          expect(result).toMatch(/^Plan set/);
        }));

      it("stores the page parent", () =>
        planned((workflow) => {
          expect(workflow.store.stagePlan()?.page_parent).toBe("page-1");
        }));
    });
  });

  describe("a concurrency over the config limit, on a workflow of a tracker issue", () => {
    let result: string;
    let cap: number;
    const planned = scenario(freshRuntime, async (workflow) => {
      cap = workflow.config().orchestrator.sandbox.max_concurrency;
      workflow.store.updateWorkflow({ origin: TRACKER_ORIGIN });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Fix the login redirect",
            definition: "development",
            stages: ["implement"],
            repo: "acme/app",
            page_parent: null,
            reason: "test",
            concurrency: cap + 10,
          },
          call,
        ),
      );
    });

    it("answers with the capped job limit", () =>
      planned(() => {
        expect(result).toContain(`up to ${cap} jobs at once`);
      }));

    it("caps the concurrency at the limit", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.job_slots).toBe(cap);
      }));

    it("stores the repository", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.repo).toBe("acme/app");
      }));

    it("logs the plan it took", () =>
      planned((workflow) => {
        expect(workflow.lines).toContain(
          `plan: definition=development name=Fix the login redirect stages=implement repo=acme/app concurrency=${cap} (test)`,
        );
      }));

    it("does not move the tracker issue, since the workflow started before the plan", () =>
      planned((workflow) => {
        expect(workflow.store.outbox()).toEqual([]);
      }));
  });

  describe("a concurrency under the config limit", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Fix the login redirect",
          definition: "development",
          stages: ["implement"],
          repo: "acme/app",
          page_parent: null,
          reason: "test",
          concurrency: 1,
        },
        call,
      );
    });

    it("keeps the concurrency as given", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.job_slots).toBe(1);
      }));

    it("writes nothing to the outbox, since no issue started the workflow", () =>
      planned((workflow) => {
        expect(workflow.store.outbox()).toEqual([]);
      }));
  });

  describe("a repository the code host does not grant access to", () => {
    let result: string;
    const input = {
      name: "Fix it",
      definition: "development",
      stages: ["implement"],
      repo: "acme/other",
      page_parent: null,
      reason: "test",
    };
    const refused = scenario(freshRuntime, async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({ repositories: ["acme/app", "acme/docs"] });
      const { set_plan } = planTools(workflow);
      result = toolText(await set_plan.execute(input, call));
    });

    it("refuses and lists the repositories the host grants", () =>
      refused(() => {
        expect(result).toBe(
          "Repository acme/other is not reachable. The code host grants access to: acme/app, acme/docs. Use one of those when it matches the request, else ask for a repository link with ask and stop.",
        );
      }));

    it("plans no stages", () =>
      refused((workflow) => {
        expect(workflow.store.stagePlan()).toBeNull();
      }));

    describe("and a second call that names a granted repository", () => {
      const granted = scenario(refused, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(await set_plan.execute({ ...input, repo: "acme/docs" }, call));
      });

      it("answers that the plan is set", () =>
        granted(() => {
          expect(result).toMatch(/^Plan set/);
        }));

      it("stores the granted repository", () =>
        granted((workflow) => {
          expect(workflow.store.stagePlan()?.repo).toBe("acme/docs");
        }));
    });
  });

  describe("a repository check GitHub cannot answer", () => {
    const input = {
      name: "Fix it",
      definition: "development",
      stages: ["implement"],
      repo: "acme/app",
      page_parent: null,
      reason: "test",
    };
    const failing = scenario(freshRuntime, (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({ failing: true });
    });

    it("asks for another set_plan call", () =>
      failing(async (workflow) => {
        const { set_plan } = planTools(workflow);
        expect(await set_plan.execute(input, call)).toMatch(
          /^Could not check repository acme\/app: .*Call set_plan again\.$/,
        );
      }));

    describe("with no GitHub client at all", () => {
      const withoutGitHub = scenario(failing, (workflow) => {
        workflow.codeHostInstance = null;
      });

      it("skips the check and sets the plan", () =>
        withoutGitHub(async (workflow) => {
          const { set_plan } = planTools(workflow);
          expect(await set_plan.execute(input, call)).toMatch(/^Plan set/);
        }));
    });
  });

  describe("a second plan while a task of the first one exists", () => {
    let result: string;
    const replanning = scenario(freshRuntime, async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({ repositories: ["acme/app"] });
      workflow.store.updateWorkflow({ origin: TRACKER_ORIGIN });
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Write the design",
          definition: "development",
          stages: ["design"],
          repo: null,
          page_parent: null,
          reason: "docs",
        },
        call,
      );
      seedTask(workflow, { stage: "design" });
    });

    it("refuses a repository GitHub does not grant", () =>
      replanning(async (workflow) => {
        const { set_plan } = planTools(workflow);
        expect(
          await set_plan.execute(
            {
              name: "Build it",
              definition: "development",
              stages: ["implement"],
              repo: "acme/other",
              page_parent: null,
              reason: "x",
            },
            call,
          ),
        ).toMatch(/^Repository acme\/other is not reachable/);
      }));

    describe("once the second plan names a granted repository", () => {
      const replanned = scenario(replanning, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(
          await set_plan.execute(
            {
              name: "Build it",
              definition: "development",
              stages: ["implement"],
              repo: "acme/app",
              page_parent: null,
              reason: "code",
            },
            call,
          ),
        );
      });

      it("answers with the new stages", () =>
        replanned(() => {
          expect(result).toMatch(/^Plan set: implement/);
        }));

      it("replaces the stages, the repository, and the reason", () =>
        replanned((workflow) => {
          expect(workflow.store.requireWorkflowRow().status).toBe("running");
          expect(workflow.store.plan()?.reason).toBe("code");
          expect(workflow.store.stagePlan()).toMatchObject({
            stages: ["implement"],
            repo: "acme/app",
          });
        }));

      it("does not move the tracker issue", () =>
        replanned((workflow) => {
          expect(workflow.store.outbox()).toEqual([]);
        }));
    });
  });
});

describe("the name a plan gives the workflow", () => {
  describe("a first plan", () => {
    const named = scenario(freshRuntime, async (workflow) => {
      workflow.store.addReplyTarget(THREAD);
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Flaky checkout test",
          definition: "development",
          stages: ["design"],
          repo: null,
          page_parent: null,
          reason: "docs",
        },
        call,
      );
    });

    it("stores the name on the workflow", () =>
      named((workflow) => {
        expect(workflow.store.plan()?.name).toBe("Flaky checkout test");
      }));

    it("logs the name it took", () =>
      named((workflow) => {
        expect(workflow.lines).toContain(
          "plan: definition=development name=Flaky checkout test stages=design repo=- concurrency=100 (docs)",
        );
      }));

    it("moves no title of its own, since the turn's own steps write over it", () =>
      named((workflow) => {
        expect(workflow.store.outbox()).toEqual([]);
      }));

    describe("and a later plan that renames the workflow", () => {
      const renamed = scenario(named, async (workflow) => {
        const { set_plan } = planTools(workflow);
        await set_plan.execute(
          {
            name: "Rewrite the checkout flow",
            definition: "development",
            stages: ["design"],
            repo: null,
            page_parent: null,
            reason: "wider",
          },
          call,
        );
      });

      it("replaces the name", () =>
        renamed((workflow) => {
          expect(workflow.store.plan()?.name).toBe("Rewrite the checkout flow");
        }));
    });
  });
});

describe("list_repositories", () => {
  describe("without a code host", () => {
    it("says none is configured", () =>
      freshRuntime(async (workflow) => {
        const { list_repositories } = planTools(workflow);
        expect(await list_repositories.execute({}, call)).toBe("No code host is configured.");
      }));
  });

  describe("with a code host that grants two repositories", () => {
    let code: FakeCodeHost;
    let text: string;
    const listed = scenario(freshRuntime, async (workflow) => {
      code = new FakeCodeHost({ repositories: ["acme/app", "acme/docs"] });
      workflow.codeHostInstance = code;
      const { list_repositories } = planTools(workflow);
      text = toolText(await list_repositories.execute({}, call));
    });

    it("lists them with their count", () =>
      listed(() => {
        expect(text).toBe("Repositories (2):\n- acme/app\n- acme/docs");
      }));

    it("asks the host for them once", () =>
      listed(() => {
        expect(code.calls.map((recorded) => recorded.method)).toEqual(["repositories"]);
      }));
  });

  describe("a host call that fails", () => {
    it("reports the failure instead of throwing", () =>
      freshRuntime(async (workflow) => {
        workflow.codeHostInstance = new FakeCodeHost({ failing: true });
        const { list_repositories } = planTools(workflow);
        expect(toolText(await list_repositories.execute({}, call))).toMatch(
          /^The code host lookup failed/,
        );
      }));
  });
});

describe("set_plan on a document host that nests pages", () => {
  const EXISTING_URL = "https://docs.test/existing";

  describe("a plan with the root page stage", () => {
    let result: string;
    const planned = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow);
      result = await planWithPages(workflow, { stages: ["design"], page_parent: "db-1" });
    });

    it("creates the root page as an empty container under the page parent", () =>
      planned((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createRootPage")).toEqual([
          ["Ship it", "## Resources", "db-1"],
        ]);
      }));

    it("stores the root page", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.root_page).toEqual({
          page_id: "page-1",
          url: "https://docs.test/page-1",
          source: "container",
        });
      }));

    it("names the root page in its answer", () =>
      planned(() => {
        expect(result).toContain(
          "Created the root page https://docs.test/page-1 for stage design to fill.",
        );
      }));

    describe("and a second call", () => {
      const replanned = scenario(planned, async (workflow) => {
        result = await planWithPages(workflow, {
          stages: ["design", "implement"],
          page_parent: "db-1",
        });
      });

      it("keeps the root page and does not create another", () =>
        replanned((workflow) => {
          expect(fakeDocumentsOf(workflow).argsOf("createRootPage")).toHaveLength(1);
          expect(workflow.store.stagePlan()?.root_page?.page_id).toBe("page-1");
        }));
    });
  });

  describe("a plan with the root page stage, without a page parent", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow);
      result = await planWithPages(workflow, { stages: ["design"] });
    });

    it("asks where the documents go", () =>
      refused(() => {
        expect(result).toMatch(
          /^Stage design fills the root page, and the plan and the workflow definition do not set a page parent/,
        );
      }));

    it("does not plan the stages", () =>
      refused((workflow) => {
        expect(workflow.store.stagePlan()).toBeNull();
      }));
  });

  describe("a plan with the root page stage that names a root page", () => {
    it("refuses the named page", () =>
      freshRuntime(async (workflow) => {
        patchNestingHost(workflow, { pages: { [EXISTING_URL]: "existing-1" } });
        const result = await planWithPages(workflow, {
          stages: ["design"],
          page_parent: "db-1",
          root_page: EXISTING_URL,
        });
        expect(result).toBe("Stage design fills the root page. Pass root_page null.");
      }));
  });

  describe("a plan with the root page stage and a page parent in the workflow definition", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow);
      const { documents } = workflow.workflowDefinition();
      workflow.patchWorkflowDefinition({
        documents: { ...documents, page_parent: "db-default" },
      });
      await planWithPages(workflow, { stages: ["design"] });
    });

    it("creates the root page under the workflow definition's default", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.page_parent).toBe("db-default");
        expect(fakeDocumentsOf(workflow).argsOf("createRootPage")[0]?.[2]).toBe("db-default");
      }));
  });

  describe("a plan with a page stage but not the root page stage", () => {
    let result: string;
    const planned = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow);
      addPlanStage(workflow);
      result = await planWithPages(workflow, { stages: ["plan"], page_parent: "db-1" });
    });

    it("creates the root page as an empty container under the page parent", () =>
      planned((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createRootPage")).toEqual([
          ["Ship it", "## Resources", "db-1"],
        ]);
      }));

    it("stores the plan and the root page", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.stages).toEqual(["plan"]);
        expect(workflow.store.stagePlan()?.root_page).toEqual({
          page_id: "page-1",
          url: "https://docs.test/page-1",
          source: "container",
        });
      }));

    it("names the root page in its answer", () =>
      planned(() => {
        expect(result).toContain("Created the root page https://docs.test/page-1. Call start_job");
      }));

    describe("and start_job on that stage", () => {
      it("starts the job", () =>
        planned(async (workflow) => {
          const { start_job } = startTools(workflow, ["Write the plan."]);
          expect(await start_job.execute({ stage: "plan", brief: "Write it." }, call)).toBe(
            "Started job wf_x-1 for stage plan. Its author task is wf_x.1.",
          );
        }));
    });
  });

  describe("a plan with a page stage but not the root page stage, and a page parent in the workflow definition", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow);
      addPlanStage(workflow);
      const { documents } = workflow.workflowDefinition();
      workflow.patchWorkflowDefinition({
        documents: { ...documents, page_parent: "https://www.notion.so/acme/db-default" },
      });
      await planWithPages(workflow, { stages: ["plan"] });
    });

    it("creates the root page under the workflow definition's default", () =>
      planned((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createRootPage")).toEqual([
          ["Ship it", "## Resources", "https://www.notion.so/acme/db-default"],
        ]);
        expect(workflow.store.stagePlan()?.root_page?.source).toBe("container");
      }));
  });

  describe("a plan with a page stage but not the root page stage, without a page parent", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow, { pages: { [EXISTING_URL]: "existing-1" } });
      addPlanStage(workflow);
      fakeDocumentsOf(workflow).seedPage("existing-1", "# Directions");
      result = await planWithPages(workflow, { stages: ["plan"] });
    });

    it("asks where the documents go or which page is the root page", () =>
      refused(() => {
        expect(result).toMatch(
          /^The plan writes pages, and the plan and the workflow definition do not set a page parent/,
        );
      }));

    it("does not plan the stages or create a page", () =>
      refused((workflow) => {
        expect(workflow.store.stagePlan()).toBeNull();
        expect(fakeDocumentsOf(workflow).argsOf("createRootPage")).toEqual([]);
      }));

    describe("and a second call that names an existing root page", () => {
      const named = scenario(refused, async (workflow) => {
        result = await planWithPages(workflow, { stages: ["plan"], root_page: EXISTING_URL });
      });

      it("stores the named page as the root page", () =>
        named((workflow) => {
          expect(workflow.store.stagePlan()?.root_page).toEqual({
            page_id: "existing-1",
            url: EXISTING_URL,
            source: "named",
          });
        }));

      it("adds a resources section to it", () =>
        named((workflow) => {
          expect(fakeDocumentsOf(workflow).pageText("existing-1")).toBe(
            "# Directions\n## Resources",
          );
        }));
    });
  });

  describe("a plan without a page stage", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      patchNestingHost(workflow);
      await planWithPages(workflow, { stages: ["implement"] });
    });

    it("does not set a root page", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.stages).toEqual(["implement"]);
        expect(workflow.store.stagePlan()?.root_page).toBeNull();
      }));
  });
});

const SUBJECT_ISSUE: TrackerIssue = {
  id: "i100",
  identifier: "ENG-100",
  title: "Fix login",
  url: "https://linear.app/acme/issue/ENG-100/fix-login",
  state: { type: "unstarted", name: "Todo" },
  team_id: null,
  parent_id: null,
  project_id: null,
  labels: [],
  blockers: [],
};

const PROJECT = {
  id: "proj-1",
  name: "Login",
  url: "https://linear.app/acme/project/login-a1b2c3",
};

async function planWithSubject(workflow: FakeRuntime, subject: string): Promise<string> {
  workflow.trackerInstance = new FakeTracker({
    issues: [SUBJECT_ISSUE],
    projects: { a1b2c3: PROJECT, [PROJECT.id]: PROJECT },
  });
  return planWithPages(workflow, { stages: ["implement"], subject });
}

describe("set_plan with a subject", () => {
  describe("an issue link, in a workflow from a chat thread", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      workflow.store.updateWorkflow({ origin: THREAD });
      workflow.store.addReplyTarget(THREAD);
      await planWithSubject(workflow, SUBJECT_ISSUE.url);
    });

    it("plans the stages", () =>
      planned((workflow) => {
        expect(workflow.store.stagePlan()?.stages).toEqual(["implement"]);
      }));

    it("makes the issue the subject", () =>
      planned((workflow) => {
        expect(workflow.store.subject()).toEqual({ kind: "issue", issue_id: "i100" });
      }));

    it("links the chat thread to the subject issue", () =>
      planned((workflow) => {
        expect(
          workflow.store
            .outbox()
            .filter((row) => row.kind === "attach_chat_thread")
            .map((row) => row.target),
        ).toEqual([{ issue_id: "i100" }]);
      }));
  });

  describe("a project link", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      await planWithSubject(workflow, PROJECT.url);
    });

    it("makes the project the subject", () =>
      planned((workflow) => {
        expect(workflow.store.subject()).toEqual({ kind: "project", project_id: "proj-1" });
      }));
  });

  describe("another issue, in a workflow that has a subject", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      workflow.store.writeSubject({ kind: "project", project_id: "proj-1" });
      result = await planWithSubject(workflow, SUBJECT_ISSUE.url);
    });

    it("says the subject never changes", () =>
      refused(() => {
        expect(result).toBe(
          `The subject of this workflow is Login (${PROJECT.url}), and it never changes. Leave subject out, and ask the person to start a new workflow for the other issue.`,
        );
      }));

    it("keeps the subject", () =>
      refused((workflow) => {
        expect(workflow.store.subject()).toEqual({ kind: "project", project_id: "proj-1" });
      }));
  });

  describe("a link the tracker does not hold", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      result = await planWithSubject(workflow, "https://linear.app/acme/issue/ENG-999/gone");
    });

    it("says the link is not an issue or a project", () =>
      refused(() => {
        expect(result).toBe(
          "The subject https://linear.app/acme/issue/ENG-999/gone is not an issue or a project on the tracker. Pass the link of one, or leave subject out.",
        );
      }));

    it("leaves the workflow without a subject", () =>
      refused((workflow) => {
        expect(workflow.store.subject()).toBeNull();
      }));
  });
});
