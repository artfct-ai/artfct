import type { ToolSet } from "ai";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import {
  patchModelExecution,
  seedModelAuthor,
  seedPullRequestTask,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import {
  activeToolNames,
  needsContext,
  needsHarness,
  needsReview,
  systemPrompt,
  type TurnFacts,
} from "./system-prompt";
import { stageAfterInput } from "../message/input-artifact";
import { RUNTIME_RULES } from "./runtime";
import { REVIEW_RULES } from "../tools/artifact";
import { CHANNEL_RULES, NOBODY_WROTE_RULES, PERSON_WROTE_RULES } from "../tools/channel";
import { HELD_COMMENT_RULES } from "../tools/held-comments";
import { PLAN_RULES } from "../tools/plan";
import { ROOT_PAGE_RULES } from "../tools/root-page";
import { CONTEXT_RULES } from "../tools/read";
import { TASK_RULES } from "../tools/start/start";
import { HARNESS_RULES } from "../tools/task";
import { workflowTools } from "../tools/toolset";
import { TRACKER_RULES } from "../tools/tracker";
import { WEB_RULES } from "../tools/web";
import { registeredConfig } from "../../config/register-config";

const RULES = {
  plan: PLAN_RULES,
  task: TASK_RULES,
  runtime: RUNTIME_RULES,
  harness: HARNESS_RULES,
  review: REVIEW_RULES,
  heldComments: HELD_COMMENT_RULES,
  rootPage: ROOT_PAGE_RULES,
  tracker: TRACKER_RULES,
  web: WEB_RULES,
  channel: CHANNEL_RULES,
  personWrote: PERSON_WROTE_RULES,
  nobodyWrote: NOBODY_WROTE_RULES,
  context: CONTEXT_RULES,
  writing: registeredConfig().writingRules,
};

function carriedRules(prompt: string): string[] {
  return Object.entries(RULES)
    .filter(([, rules]) => prompt.includes(rules))
    .map(([name]) => name);
}

function toolsWithMcp(workflow: FakeRuntime): ToolSet {
  const tools = workflowTools(workflow);
  return { ...tools, tool_linear_get_issue: tools.status };
}

const NOBODY_WROTE: TurnFacts = { personWrote: false, requestsWork: true, inputArtifact: null };
const PERSON_WROTE: TurnFacts = { personWrote: true, requestsWork: true, inputArtifact: null };
const PERSON_WROTE_NO_WORK: TurnFacts = {
  personWrote: true,
  requestsWork: false,
  inputArtifact: null,
};

function stageLine(workflow: FakeRuntime, name: string): string | undefined {
  return systemPrompt(workflow, NOBODY_WROTE)
    .split("\n")
    .find((line) => line.startsWith(`- ${name}:`));
}

const planWithTask = scenario(freshRuntime, (workflow) => {
  workflow.patchState({ stages: ["implement"] });
  seedTask(workflow, { stage: "implement" });
});

const planUnderReview = scenario(freshRuntime, (workflow) => {
  workflow.patchState({ stages: ["implement"] });
  seedPullRequestTask(workflow);
});

describe("needsHarness", () => {
  describe("a fresh workflow", () => {
    it("is false", () =>
      freshRuntime((workflow) => {
        expect(needsHarness(workflow)).toBe(false);
      }));
  });

  describe("a plan with no task started", () => {
    const planned = scenario(freshRuntime, (workflow) => {
      workflow.patchState({ stages: ["implement"] });
    });

    it("is false", () =>
      planned((workflow) => {
        expect(needsHarness(workflow)).toBe(false);
      }));
  });

  describe("a task that runs", () => {
    const running = scenario(freshRuntime, (workflow) => {
      seedTask(workflow);
    });

    it("is true", () =>
      running((workflow) => {
        expect(needsHarness(workflow)).toBe(true);
      }));

    describe("once the task is done", () => {
      const done = scenario(running, (workflow) => {
        workflow.store.updateTask("wf_x.1", { status: "done" });
      });

      it("is false", () =>
        done((workflow) => {
          expect(needsHarness(workflow)).toBe(false);
        }));
    });
  });
});

describe("needsReview", () => {
  describe("a fresh workflow", () => {
    it("is false", () =>
      freshRuntime((workflow) => {
        expect(needsReview(workflow)).toBe(false);
      }));
  });

  describe("a task that runs with no pull request", () => {
    it("is false", () =>
      planWithTask((workflow) => {
        expect(needsReview(workflow)).toBe(false);
      }));
  });

  describe("a pull request of a failed task that the review holds", () => {
    const failedUnderReview = scenario(freshRuntime, (workflow) => {
      seedPullRequestTask(workflow, { status: "failed" });
    });

    it("is true", () =>
      failedUnderReview((workflow) => {
        expect(needsReview(workflow)).toBe(true);
      }));
  });

  describe("a pull request the humans have", () => {
    const announced = scenario(freshRuntime, (workflow) => {
      seedPullRequestTask(workflow, {}, { status: "ready" });
    });

    it("is false", () =>
      announced((workflow) => {
        expect(needsReview(workflow)).toBe(false);
      }));
  });
});

describe("needsContext", () => {
  describe("a fresh workflow", () => {
    it("is true", () =>
      freshRuntime((workflow) => {
        expect(needsContext(workflow)).toBe(true);
      }));
  });

  describe("a plan with no task started", () => {
    const planned = scenario(freshRuntime, (workflow) => {
      workflow.patchState({ stages: ["implement"] });
    });

    it("is true", () =>
      planned((workflow) => {
        expect(needsContext(workflow)).toBe(true);
      }));
  });

  describe("a planned task that runs", () => {
    it("is false", () =>
      planWithTask((workflow) => {
        expect(needsContext(workflow)).toBe(false);
      }));
  });
});

describe("systemPrompt", () => {
  describe("a fresh workflow", () => {
    it("carries the planning and context rules and no others", () =>
      freshRuntime((workflow) => {
        expect(carriedRules(systemPrompt(workflow, NOBODY_WROTE))).toEqual([
          "plan",
          "task",
          "runtime",
          "tracker",
          "web",
          "channel",
          "nobodyWrote",
          "context",
          "writing",
        ]);
      }));

    it("names the harnesses it can run", () =>
      freshRuntime((workflow) => {
        expect(systemPrompt(workflow, NOBODY_WROTE)).toContain(
          "\n## Harnesses and models\nHarnesses: claude-code, opencode.\n",
        );
      }));
  });

  describe("the current state block", () => {
    describe("a workflow the plan named", () => {
      it("carries the name, so a replan repeats it instead of inventing one", () =>
        freshRuntime((workflow) => {
          workflow.patchState({ name: "Flaky checkout test" });
          expect(systemPrompt(workflow, NOBODY_WROTE)).toContain("\nName: Flaky checkout test\n");
        }));
    });

    describe("a workflow before its first plan", () => {
      it("carries the request title", () =>
        freshRuntime((workflow) => {
          workflow.state.request = { ...workflow.state.request, title: "fix the flaky test" };
          expect(systemPrompt(workflow, NOBODY_WROTE)).toContain("\nName: fix the flaky test\n");
        }));
    });
  });

  describe("a workflow in review", () => {
    it("carries the harness and review rules and drops the context rules", () =>
      planUnderReview((workflow) => {
        expect(carriedRules(systemPrompt(workflow, NOBODY_WROTE))).toEqual([
          "plan",
          "task",
          "harness",
          "review",
          "tracker",
          "web",
          "channel",
          "nobodyWrote",
          "writing",
        ]);
      }));

    it("sends a follow-up to the author on an existing job and omits the locked board directive", () =>
      planUnderReview((workflow) => {
        const prompt = systemPrompt(workflow, NOBODY_WROTE);
        expect(prompt).toContain(
          "* **Dispatch** follow-up edits to the author task of the existing job using `prompt_task`.",
        );
        expect(prompt).not.toContain("board remains locked");
      }));

    it("drops the list of harnesses and models", () =>
      planUnderReview((workflow) => {
        expect(systemPrompt(workflow, NOBODY_WROTE)).not.toContain("## Harnesses and models");
      }));

    it("names the harness and model the task runs on", () =>
      planUnderReview((workflow) => {
        expect(systemPrompt(workflow, NOBODY_WROTE)).toContain(" harness=opencode model=mock ");
      }));
  });

  describe("a stage the config gives a condition", () => {
    const conditional = scenario(freshRuntime, (workflow) => {
      workflow.patchWorkflowDefinition({
        stages: workflow
          .workflowDefinition()
          .stages.map((stage) =>
            stage.name === "breakdown"
              ? { ...stage, when: "the plan needs more than one pull request" }
              : stage,
          ),
      });
    });

    it("says when the stage belongs in a plan", () =>
      conditional((workflow) => {
        expect(systemPrompt(workflow, NOBODY_WROTE)).toContain(
          " Only when the plan needs more than one pull request.",
        );
      }));

    it("says nothing of the kind for a stage with no condition", () =>
      conditional((workflow) => {
        const design = systemPrompt(workflow, NOBODY_WROTE)
          .split("\n")
          .find((line) => line.startsWith("- design:"));
        expect(design).not.toContain("Only when");
      }));
  });

  describe("a stage the config gives a research step", () => {
    const researched = scenario(freshRuntime, (workflow) => {
      workflow.patchWorkflowDefinition({
        stages: workflow
          .workflowDefinition()
          .stages.map((stage) =>
            stage.name === "design"
              ? { ...stage, research: { skill: "research", model: "research-model" } }
              : stage,
          ),
      });
    });

    it("says a researcher runs first, on the default harness and its own model", () =>
      researched((workflow) => {
        expect(stageLine(workflow, "design")).toContain(
          " A researcher runs first on harness claude-code, model research-model.",
        );
      }));

    it("says nothing of the kind for a stage with no research step", () =>
      researched((workflow) => {
        expect(stageLine(workflow, "implement")).not.toContain("researcher");
      }));
  });

  describe("a stage with a choice ending", () => {
    const choosing = scenario(freshRuntime, (workflow) => {
      workflow.patchWorkflowDefinition({
        stages: workflow
          .workflowDefinition()
          .stages.map((stage) =>
            stage.name === "design" ? { ...stage, ending: "choice" as const } : stage,
          ),
      });
    });

    it("says its job completes on a selected option", () =>
      choosing((workflow) => {
        expect(stageLine(workflow, "design")).toContain("Pass that option to complete_job.");
      }));

    it("says nothing of the kind for a stage that ends on acceptance", () =>
      choosing((workflow) => {
        expect(stageLine(workflow, "implement")).not.toContain("choice");
      }));
  });

  describe("a message that names an input artifact", () => {
    const NAMES_ISSUES: TurnFacts = { ...PERSON_WROTE, inputArtifact: "issues" };

    it("names the stage after the last stage that produces it", () =>
      freshRuntime(async (workflow) => {
        const start = stageAfterInput(workflow.workflowDefinition().stages, "issues");
        expect(start).not.toBeNull();
        expect(systemPrompt(workflow, NAMES_ISSUES)).toContain(
          `Start the plan at stage ${start} unless the message names an earlier stage.`,
        );
      }));

    it("does not name a start stage while a job runs", () =>
      planWithTask((workflow) => {
        expect(systemPrompt(workflow, NAMES_ISSUES)).not.toContain("Where the plan starts");
      }));

    it("does not name a start stage when the message has no input artifact", () =>
      freshRuntime(async (workflow) => {
        expect(systemPrompt(workflow, PERSON_WROTE)).not.toContain("Where the plan starts");
      }));
  });
});

describe("activeToolNames", () => {
  describe("a fresh workflow", () => {
    it("withholds the harness and review tools that no carried rule names", () =>
      freshRuntime((workflow) => {
        const tools = toolsWithMcp(workflow);
        const active = activeToolNames(workflow, tools, NOBODY_WROTE);
        const dropped = Object.keys(tools).filter((name) => !active.includes(name));
        expect(dropped.toSorted()).toEqual([
          "acknowledge",
          "cancel_task",
          "finish_review",
          "move_into_root_page",
          "pause_task",
          "read_artifact",
          "request_review",
          "resume_task",
          "send_held_comments",
        ]);
      }));

    it("keeps the MCP tools", () =>
      freshRuntime((workflow) => {
        expect(activeToolNames(workflow, toolsWithMcp(workflow), NOBODY_WROTE)).toContain(
          "tool_linear_get_issue",
        );
      }));

    it("keeps the tools a plan needs", () =>
      freshRuntime((workflow) => {
        expect(activeToolNames(workflow, toolsWithMcp(workflow), NOBODY_WROTE)).toContain(
          "read_task",
        );
      }));
  });

  const failedUnderReview = scenario(freshRuntime, (workflow) => {
    seedPullRequestTask(workflow, { status: "failed" });
  });

  describe("a pull request of a failed task that the review holds", () => {
    it("carries the review rules without the harness rules", () =>
      failedUnderReview((workflow) => {
        expect(carriedRules(systemPrompt(workflow, NOBODY_WROTE))).not.toContain("harness");
        expect(carriedRules(systemPrompt(workflow, NOBODY_WROTE))).toContain("review");
      }));

    it("keeps cancel_task, which the review rules name", () =>
      failedUnderReview((workflow) => {
        expect(activeToolNames(workflow, workflowTools(workflow), NOBODY_WROTE)).toContain(
          "cancel_task",
        );
      }));

    it("withholds the harness tools no carried rule names", () =>
      failedUnderReview((workflow) => {
        const active = activeToolNames(workflow, workflowTools(workflow), NOBODY_WROTE);
        expect(active).not.toContain("pause_task");
        expect(active).not.toContain("resume_task");
      }));
  });

  describe("any workflow", () => {
    const states = { fresh: freshRuntime, planWithTask, planUnderReview, failedUnderReview };

    const turns = {
      "nobody wrote": NOBODY_WROTE,
      "a person wrote": PERSON_WROTE,
      "a person wrote and requests no work": PERSON_WROTE_NO_WORK,
    };
    const cases = Object.entries(states).flatMap(([name, state]) =>
      Object.entries(turns).map(([wrote, turn]) => ({ name: `${name}, ${wrote}`, state, turn })),
    );

    for (const { name, state, turn } of cases) {
      it(`${name}: every tool the system prompt names is active`, () =>
        state((workflow) => {
          const tools = workflowTools(workflow);
          const active = activeToolNames(workflow, tools, turn);
          const prompt = systemPrompt(workflow, turn);
          const named = Object.keys(tools).filter(
            (tool) => prompt.includes(`\`${tool}\``) || prompt.includes(`\`${tool}(`),
          );
          expect(named.filter((tool) => !active.includes(tool))).toEqual([]);
        }));
    }
  });

  describe("a workflow holding a reviewed pull request", () => {
    it("keeps every tool but the ones that answer a person, send held page comments, and move pages", () =>
      planUnderReview((workflow) => {
        const tools = workflowTools(workflow);
        const withheld = ["acknowledge", "send_held_comments", "move_into_root_page"];
        const kept = Object.keys(tools).filter((name) => !withheld.includes(name));
        expect(activeToolNames(workflow, tools, NOBODY_WROTE)).toEqual(kept);
      }));
  });

  describe("a workflow with a page artifact", () => {
    const pageArtifact = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { stage: "design" });
      workflow.store.upsertArtifact({
        job_id: "wf_x-1",
        kind: "page",
        external_url: "https://www.notion.so/acme/page-1",
        ref: { kind: "page", page_id: "page-1" },
      });
    });

    it("carries the held comment rules and keeps the tool they name", () =>
      pageArtifact((workflow) => {
        expect(carriedRules(systemPrompt(workflow, PERSON_WROTE))).toContain("heldComments");
        expect(activeToolNames(workflow, workflowTools(workflow), PERSON_WROTE)).toContain(
          "send_held_comments",
        );
      }));
  });

  describe("a workflow with a root page", () => {
    const rootPage = scenario(freshRuntime, (workflow) => {
      workflow.patchState({
        root_page: { page_id: "root-1", url: "https://docs.test/root-1", source: "container" },
      });
    });

    it("carries the root page rules and keeps the tool they name", () =>
      rootPage((workflow) => {
        expect(carriedRules(systemPrompt(workflow, PERSON_WROTE))).toContain("rootPage");
        expect(activeToolNames(workflow, workflowTools(workflow), PERSON_WROTE)).toContain(
          "move_into_root_page",
        );
      }));

    it("names the root page in the state", () =>
      rootPage((workflow) => {
        expect(systemPrompt(workflow, PERSON_WROTE)).toContain(
          "Root page: https://docs.test/root-1",
        );
      }));
  });

  describe("a turn where a person wrote", () => {
    it("carries the rules for an answer and not the rules for a turn nobody asked for", () =>
      planWithTask((workflow) => {
        const carried = carriedRules(systemPrompt(workflow, PERSON_WROTE));
        expect(carried).toContain("personWrote");
        expect(carried).not.toContain("nobodyWrote");
      }));

    it("withholds stay_silent and tell, so the person gets a reply", () =>
      planWithTask((workflow) => {
        const active = activeToolNames(workflow, workflowTools(workflow), PERSON_WROTE);
        expect(active).not.toContain("stay_silent");
        expect(active).not.toContain("tell");
      }));

    it("keeps acknowledge and ask", () =>
      planWithTask((workflow) => {
        const active = activeToolNames(workflow, workflowTools(workflow), PERSON_WROTE);
        expect(active).toContain("acknowledge");
        expect(active).toContain("ask");
      }));
  });
});

describe("a turn where a person wrote and requests no work", () => {
  it("leaves the plan, runtime, and context rules out", () =>
    freshRuntime((workflow) => {
      expect(carriedRules(systemPrompt(workflow, PERSON_WROTE_NO_WORK))).toEqual([
        "task",
        "tracker",
        "web",
        "channel",
        "personWrote",
        "writing",
      ]);
    }));

  it("leaves the harness list out", () =>
    freshRuntime((workflow) => {
      expect(systemPrompt(workflow, PERSON_WROTE_NO_WORK)).not.toContain("## Harnesses and models");
    }));

  it("keeps set_plan and start_job active", () =>
    freshRuntime((workflow) => {
      const active = activeToolNames(workflow, workflowTools(workflow), PERSON_WROTE_NO_WORK);
      expect(active).toContain("set_plan");
      expect(active).toContain("start_job");
    }));

  it("keeps fetch_url active, so a lookup is answered in the turn", () =>
    freshRuntime((workflow) => {
      const active = activeToolNames(workflow, workflowTools(workflow), PERSON_WROTE_NO_WORK);
      expect(active).toContain("fetch_url");
    }));
});

describe("a turn where a person wrote and requests work", () => {
  it("carries the plan, runtime, and context rules", () =>
    freshRuntime((workflow) => {
      const carried = carriedRules(systemPrompt(workflow, PERSON_WROTE));
      expect(carried).toContain("plan");
      expect(carried).toContain("runtime");
      expect(carried).toContain("context");
    }));
});

describe("systemPrompt with a model-call author", () => {
  it("says the job runs on a model call", () =>
    freshRuntime((workflow) => {
      patchModelExecution(workflow);
      seedModelAuthor(workflow);
      expect(systemPrompt(workflow, NOBODY_WROTE)).toContain(" execution=model model=");
    }));
});
