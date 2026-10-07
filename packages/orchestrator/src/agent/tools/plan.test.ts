import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import {
  PAGE_PARENT,
  patchModelExecution,
  fakeDocumentsOf,
  patchNestingHost,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { planTools } from "./plan";

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
  fields: { stages: string[]; page_parent?: string | null; root_page?: string | null },
): Promise<string> {
  const { set_plan } = planTools(workflow);
  return toolText(
    await set_plan.execute(
      {
        name: "Ship it",
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
    stages: [design, { ...design, name: "plan", root_page: false }, ...rest],
  });
}

describe("set_plan", () => {
  describe("on a workflow that is done", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      workflow.patchState({ status: "done" });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          { name: "Ship it", stages: ["design"], repo: null, page_parent: null, reason: "more" },
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
        expect(workflow.state.status).toBe("done");
        expect(workflow.state.stages).toEqual([]);
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
        expect(result).toBe("Unknown stages: deploy, ship. Use names from the config.");
      }));

    it("plans no stages", () =>
      planned((workflow) => {
        expect(workflow.state.stages).toEqual([]);
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
        expect(workflow.state.stages).toEqual([]);
      }));

    describe("and a second call with stages that need no repository", () => {
      const documentsPlan = scenario(refused, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(
          await set_plan.execute(
            {
              name: "Write the design",
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
          expect(workflow.state).toMatchObject({
            status: "running",
            stages: ["design"],
            repo: null,
            reason: "docs",
          });
        }));
    });
  });

  describe("a stage whose author writes its page as a model call, with no page parent", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.patchState({ page_parent: null });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          { name: "Ship it", stages: ["design"], repo: null, page_parent: null, reason: "test" },
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
        expect(workflow.state.stages).toEqual([]);
      }));

    describe("and a second call that names one", () => {
      const planned = scenario(refused, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(
          await set_plan.execute(
            {
              name: "Ship it",
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
          expect(workflow.state.page_parent).toBe("page-1");
        }));
    });
  });

  describe("a concurrency over the config limit, on a workflow a tracker issue started", () => {
    let result: string;
    let cap: number;
    const planned = scenario(freshRuntime, async (workflow) => {
      cap = workflow.config().orchestrator.sandbox.max_concurrency;
      workflow.patchState({ origin: TRACKER_ORIGIN });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          {
            name: "Fix the login redirect",
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
        expect(workflow.state.concurrency).toBe(cap);
      }));

    it("stores the repository", () =>
      planned((workflow) => {
        expect(workflow.state.repo).toEqual({ full: "acme/app" });
      }));

    it("logs the plan it took", () =>
      planned((workflow) => {
        expect(workflow.lines).toContain(
          `plan: name=Fix the login redirect stages=implement repo=acme/app concurrency=${cap} (test)`,
        );
      }));

    it("moves the tracker issue to started", () =>
      planned((workflow) => {
        expect(workflow.store.outbox().map((entry) => [entry.kind, entry.payload])).toEqual([
          ["issue_update", { to: "started", delegate: null }],
        ]);
      }));
  });

  describe("a concurrency under the config limit", () => {
    const planned = scenario(freshRuntime, async (workflow) => {
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Fix the login redirect",
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
        expect(workflow.state.concurrency).toBe(1);
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
        expect(workflow.state.stages).toEqual([]);
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
          expect(workflow.state.repo).toEqual({ full: "acme/docs" });
        }));
    });
  });

  describe("a repository check GitHub cannot answer", () => {
    const input = {
      name: "Fix it",
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
      workflow.patchState({ origin: TRACKER_ORIGIN });
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Write the design",
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
          expect(workflow.state).toMatchObject({
            status: "running",
            stages: ["implement"],
            repo: { full: "acme/app" },
            reason: "code",
          });
        }));

      it("moves the tracker issue only the first time", () =>
        replanned((workflow) => {
          expect(workflow.store.outbox().map((entry) => entry.kind)).toEqual(["issue_update"]);
        }));
    });
  });
});

describe("the name a plan gives the workflow", () => {
  describe("a first plan", () => {
    const named = scenario(freshRuntime, async (workflow) => {
      workflow.patchState({ reply_targets: [THREAD] });
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Flaky checkout test",
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
        expect(workflow.state.name).toBe("Flaky checkout test");
      }));

    it("logs the name it took", () =>
      named((workflow) => {
        expect(workflow.lines).toContain(
          "plan: name=Flaky checkout test stages=design repo=- concurrency=100 (docs)",
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
          expect(workflow.state.name).toBe("Rewrite the checkout flow");
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

  describe("on a document host that nests pages", () => {
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
            ["Ship it (design)", "## Resources", "db-1"],
          ]);
        }));

      it("stores the root page", () =>
        planned((workflow) => {
          expect(workflow.state.root_page).toEqual({
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

        it("keeps the root page and creates no other", () =>
          replanned((workflow) => {
            expect(fakeDocumentsOf(workflow).argsOf("createRootPage")).toHaveLength(1);
            expect(workflow.state.root_page?.page_id).toBe("page-1");
          }));
      });
    });

    describe("a plan with the root page stage and no page parent", () => {
      let result: string;
      const refused = scenario(freshRuntime, async (workflow) => {
        patchNestingHost(workflow);
        result = await planWithPages(workflow, { stages: ["design"] });
      });

      it("asks where the documents go", () =>
        refused(() => {
          expect(result).toMatch(/^Stage design makes the root page, and no page parent/);
        }));

      it("plans no stages", () =>
        refused((workflow) => {
          expect(workflow.state.stages).toEqual([]);
        }));
    });

    describe("a plan with the root page stage and a page parent in the workflow definition", () => {
      const planned = scenario(freshRuntime, async (workflow) => {
        patchNestingHost(workflow);
        workflow.patchWorkflowDefinition({ page_parent: "db-default" });
        await planWithPages(workflow, { stages: ["design"] });
      });

      it("creates the root page under the workflow definition's default", () =>
        planned((workflow) => {
          expect(workflow.state.page_parent).toBe("db-default");
          expect(fakeDocumentsOf(workflow).argsOf("createRootPage")[0]?.[2]).toBe("db-default");
        }));
    });

    describe("a plan with a page stage but not the root page stage", () => {
      let result: string;
      const refused = scenario(freshRuntime, async (workflow) => {
        patchNestingHost(workflow, { pages: { [EXISTING_URL]: "existing-1" } });
        addPlanStage(workflow);
        fakeDocumentsOf(workflow).seedPage("existing-1", "# Directions");
        result = await planWithPages(workflow, { stages: ["plan"], page_parent: PAGE_PARENT });
      });

      it("asks which page is the root page", () =>
        refused(() => {
          expect(result).toMatch(
            /^The plan writes pages, and no planned stage makes the root page/,
          );
        }));

      describe("and a second call that names one", () => {
        const named = scenario(refused, async (workflow) => {
          result = await planWithPages(workflow, {
            stages: ["plan"],
            page_parent: PAGE_PARENT,
            root_page: EXISTING_URL,
          });
        });

        it("stores the named page as the root page", () =>
          named((workflow) => {
            expect(workflow.state.root_page).toEqual({
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

      it("sets no root page", () =>
        planned((workflow) => {
          expect(workflow.state.stages).toEqual(["implement"]);
          expect(workflow.state.root_page).toBeNull();
        }));
    });
  });
});
