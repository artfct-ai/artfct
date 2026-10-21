import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { describe, expect, it } from "vitest";
import { unstartedDurableRuntime } from "../../../test/durable-runtime";
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

describe("set_plan on a workflow that has not started", () => {
  describe("start_job before the plan", () => {
    it("asks for the plan that starts the workflow", () =>
      unstartedDurableRuntime(async (workflow) => {
        const { start_job } = startTools(workflow, ["Fix it."]);
        expect(await start_job.execute({ stage: "implement", brief: "Fix it." }, call)).toBe(
          "The workflow has not started. Call set_plan with a workflow definition first.",
        );
        expect(workflow.store.jobs()).toEqual([]);
      }));
  });

  describe("a first plan without stages that names a repository", () => {
    let result: string;
    const startInput = { name: "Fix it", definition: "development", reason: "test" };
    const started = scenario(unstartedDurableRuntime, async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({ repositories: ["acme/app"] });
      const { set_plan } = planTools(workflow);
      result = toolText(await set_plan.execute({ ...startInput, repo: "acme/app" }, call));
    });

    it("starts the workflow", () =>
      started((workflow) => {
        expect(result).toMatch(/^Workflow started/);
        expect(workflow.store.requireWorkflowRow().status).toBe("running");
      }));

    it("stores the repository without a stage plan", () =>
      started((workflow) => {
        expect(workflow.store.workflowRow()?.repo).toBe("acme/app");
        expect(workflow.store.stagePlan()).toBeNull();
      }));

    describe("one the code host does not grant", () => {
      const refused = scenario(unstartedDurableRuntime, async (workflow) => {
        workflow.codeHostInstance = new FakeCodeHost({ repositories: ["acme/app"] });
        const { set_plan } = planTools(workflow);
        result = toolText(await set_plan.execute({ ...startInput, repo: "acme/other" }, call));
      });

      it("refuses and does not start the workflow", () =>
        refused((workflow) => {
          expect(result).toMatch(/^Repository acme\/other is not reachable/);
          expect(workflow.store.workflowRow()).toBeNull();
        }));
    });
  });

  describe("the call that starts a workflow from a tracker issue, without stages", () => {
    let result: string;
    const started = scenario(unstartedDurableRuntime, async (workflow) => {
      workflow.patchConversation({ origin: TRACKER_ORIGIN });
      const { set_plan } = planTools(workflow);
      result = toolText(
        await set_plan.execute(
          { name: "Ship it", definition: "development", reason: "the request" },
          call,
        ),
      );
    });

    it("answers with the stages of the workflow definition and asks for the plan", () =>
      started(() => {
        expect(result).toMatch(
          /^Workflow started from workflow definition development\.\n\n## Stages \(in order\)\n- design: produces page\./,
        );
        expect(result).toMatch(
          /Call set_plan again with definition development and the stages to run\.$/,
        );
      }));

    it("stores the workflow definition and the name, and runs without stages", () =>
      started((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("running");
        expect(workflow.store.workflowRow()).toMatchObject({
          definition: "development",
          name: "Ship it",
        });
        expect(workflow.store.stagePlan()).toBeNull();
      }));

    it("moves the tracker issue to started", () =>
      started((workflow) => {
        expect(workflow.store.outbox().map((entry) => [entry.kind, entry.payload])).toEqual([
          ["issue_update", { to: "started", delegate: null }],
        ]);
      }));

    describe("and the call with the stages", () => {
      const planned = scenario(started, async (workflow) => {
        const { set_plan } = planTools(workflow);
        result = toolText(
          await set_plan.execute(
            {
              name: "Ship it",
              definition: "development",
              stages: ["design"],
              repo: null,
              page_parent: null,
              reason: "the request",
            },
            call,
          ),
        );
      });

      it("sets the plan", () =>
        planned((workflow) => {
          expect(result).toMatch(/^Plan set: design/);
          expect(workflow.store.stagePlan()?.stages).toEqual(["design"]);
        }));

      it("does not move the tracker issue again", () =>
        planned((workflow) => {
          expect(workflow.store.outbox().map((entry) => entry.kind)).toEqual(["issue_update"]);
        }));
    });
  });

  describe("the call that starts a workflow from a tracker issue, with stages", () => {
    const planned = scenario(unstartedDurableRuntime, async (workflow) => {
      workflow.patchConversation({ origin: TRACKER_ORIGIN });
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Fix it",
          definition: "development",
          stages: ["implement"],
          repo: "acme/app",
          page_parent: null,
          reason: "x",
        },
        call,
      );
    });

    it("starts the workflow and sets the plan", () =>
      planned((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("running");
        expect(workflow.store.workflowRow()?.definition).toBe("development");
        expect(workflow.store.stagePlan()?.stages).toEqual(["implement"]);
      }));

    it("moves the tracker issue to started", () =>
      planned((workflow) => {
        expect(workflow.store.outbox().map((entry) => [entry.kind, entry.payload])).toEqual([
          ["issue_update", { to: "started", delegate: null }],
        ]);
      }));
  });

  describe("a first plan that names a second workflow definition", () => {
    const incident = scenario(unstartedDurableRuntime, async (workflow) => {
      const [, , implement] = workflow.workflowDefinitions()[0]?.stages ?? [];
      if (!implement) throw new Error("the test definition does not have an implement stage");
      workflow.addWorkflowDefinition({
        name: "incident",
        description: "Fix an incident.",
        documents: {},
        triggers: [],
        stages: [implement],
      });
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Fix it",
          definition: "incident",
          stages: ["implement"],
          repo: "acme/app",
          page_parent: null,
          reason: "x",
        },
        call,
      );
    });

    it("starts the workflow on that workflow definition", () =>
      incident((workflow) => {
        expect(workflow.store.requireWorkflowRow().status).toBe("running");
        expect(workflow.store.workflowRow()?.definition).toBe("incident");
        expect(workflow.workflowDefinition().name).toBe("incident");
      }));
  });
});
