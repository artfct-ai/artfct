import type { PlanEntry } from "@agentclientprotocol/sdk";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { acceptingD1 } from "../../../test/accepting-d1";
import { EchoModel, ScriptedFailure } from "../../../test/fake-model";
import {
  patchModelExecution,
  patchStageResearch,
  patchStageReviewers,
  FakeRuntime,
} from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { scenario, type Scenario } from "../../../test/scenario";
import { testEnv } from "../../../test/test-env";
import { startAuthorAfterResearch, startJob } from "../lifecycle";
import { runModelAuthorTurn } from "../task/model-author";
import { boardInputOf } from "./board";
import { BOARD_MAX_ENTRIES, renderBoard } from "./render";

const JOB = "wf_x-1";

const RESEARCH_TODOS = [
  { content: "Read the request", priority: "high" as const, status: "completed" as const },
  { content: "Map the login module", priority: "high" as const, status: "completed" as const },
  { content: "Write the payload", priority: "medium" as const, status: "in_progress" as const },
];

function checklistOf(workflow: FakeRuntime): string[] {
  return renderBoard(boardInputOf(workflow, JOB)).body.split("\n").slice(2);
}

function researcherOf(workflow: FakeRuntime) {
  const researcher = workflow.store.researcherTask(JOB);
  if (!researcher) throw new Error("the job has no researcher");
  return researcher;
}

function authorOf(workflow: FakeRuntime) {
  return workflow.store.authorTaskOf(JOB);
}

const runtimeWithD1: Scenario<FakeRuntime> = async (run) => {
  await run(new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: acceptingD1() }));
};

const researching = scenario(runtimeWithD1, async (workflow) => {
  patchStageResearch(workflow);
  patchModelExecution(workflow);
  patchStageReviewers(workflow, []);
  await startJob(workflow, {
    stage: "design",
    brief: "Fix the login redirect.",
    input: { kind: "request", text: "Fix the login redirect." },
  });
  workflow.store.updateTask(researcherOf(workflow).task_id, { status: "working" });
  workflow.store.setTodos(researcherOf(workflow).task_id, { entries: RESEARCH_TODOS });
});

const handedOver = scenario(researching, async (workflow) => {
  await startAuthorAfterResearch(workflow, researcherOf(workflow), "Findings.");
});

describe("the board of a job whose research hands over to a model-call author", () => {
  describe("while research runs", () => {
    it("lists the research todo list alone", () =>
      researching((workflow) => {
        expect(checklistOf(workflow)).toEqual([
          "☑ Read the request",
          "☑ Map the login module",
          "☐ Write the payload ← working",
        ]);
      }));
  });

  describe("once the author starts", () => {
    it("keeps the research todo list, every entry complete, and adds the author's work line", () =>
      handedOver((workflow) => {
        expect(checklistOf(workflow)).toEqual([
          "☑ Read the request",
          "☑ Map the login module",
          "☑ Write the payload",
          "☐ produce ← starting",
        ]);
      }));
  });

  describe("while the model call produces the page", () => {
    const producing = scenario(handedOver, (workflow) => {
      workflow.store.updateTask(authorOf(workflow).task_id, { status: "working" });
    });

    it("says the author produces", () =>
      producing((workflow) => {
        expect(checklistOf(workflow).at(-1)).toBe("☐ produce ← working");
      }));
  });

  describe("once the model call created the page", () => {
    const produced = scenario(handedOver, async (workflow) => {
      workflow.modelInstance = new EchoModel("# Directions");
      await runModelAuthorTurn(workflow, authorOf(workflow));
    });

    it("checks the produce line under the research", () =>
      produced((workflow) => {
        expect(checklistOf(workflow).slice(0, 4)).toEqual([
          "☑ Read the request",
          "☑ Map the login module",
          "☑ Write the payload",
          "☑ produce",
        ]);
      }));

    describe("and the author runs again", () => {
      const revising = scenario(produced, (workflow) => {
        workflow.store.updateTask(authorOf(workflow).task_id, { status: "working" });
      });

      it("keeps the produce line checked", () =>
        revising((workflow) => {
          expect(checklistOf(workflow).at(3)).toBe("☑ produce");
        }));
    });

    describe("and the author fails after it", () => {
      const failedLater = scenario(produced, (workflow) => {
        workflow.store.updateTask(authorOf(workflow).task_id, { status: "failed" });
      });

      it("keeps the produce line checked", () =>
        failedLater((workflow) => {
          expect(checklistOf(workflow).at(3)).toBe("☑ produce");
        }));
    });
  });

  describe("when the model call fails", () => {
    const failed = scenario(handedOver, async (workflow) => {
      workflow.modelInstance = new ScriptedFailure(["throw"]);
      await runModelAuthorTurn(workflow, authorOf(workflow));
    });

    it("says the produce activity failed under the research", () =>
      failed((workflow) => {
        expect(checklistOf(workflow).slice(-2)).toEqual([
          "☑ Write the payload",
          "☐ produce ← failed",
        ]);
      }));
  });
});

const harnessResearching = scenario(runtimeWithD1, async (workflow) => {
  patchStageResearch(workflow);
  patchStageReviewers(workflow, []);
  await startJob(workflow, {
    stage: "implement",
    brief: "Fix the login redirect.",
    input: { kind: "request", text: "Fix the login redirect." },
  });
  workflow.store.updateTask(researcherOf(workflow).task_id, { status: "working" });
});

const harnessHandedOver = scenario(harnessResearching, async (workflow) => {
  await startAuthorAfterResearch(workflow, researcherOf(workflow), "Findings.");
});

function withAuthorStatus(status: TaskStatus): Scenario<FakeRuntime> {
  return scenario(harnessHandedOver, (workflow) => {
    workflow.store.updateTask(authorOf(workflow).task_id, { status });
  });
}

function recordPullRequest(workflow: FakeRuntime): void {
  workflow.store.upsertArtifact({
    job_id: JOB,
    kind: "pull",
    external_url: "https://github.com/acme/app/pull/1",
    ref: { kind: "pull", repo: "acme/app", number: 1 },
  });
}

function pendingTodos(count: number): PlanEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    content: `Step ${index + 1}`,
    priority: "medium" as const,
    status: "pending" as const,
  }));
}

describe("the board of a job whose research hands over to a harness author", () => {
  it("shows a researcher without a todo list as its open work line", () =>
    harnessResearching((workflow) => {
      expect(checklistOf(workflow)).toEqual(["☐ research ← working"]);
    }));

  it("checks the research once the researcher is done", () =>
    harnessHandedOver((workflow) => {
      expect(checklistOf(workflow)).toEqual(["☑ research", "☐ produce ← starting"]);
    }));

  it("shows an author without an artifact as its open work line", () =>
    withAuthorStatus("working")((workflow) => {
      expect(checklistOf(workflow)).toEqual(["☑ research", "☐ produce ← working"]);
    }));

  it("checks the work line of an author with an artifact while it still works", () =>
    withAuthorStatus("working")((workflow) => {
      recordPullRequest(workflow);
      expect(checklistOf(workflow).slice(0, 2)).toEqual(["☑ research", "☑ produce"]);
    }));

  it("checks the work line of an author idle in review", () =>
    withAuthorStatus("in_review")((workflow) => {
      recordPullRequest(workflow);
      expect(checklistOf(workflow).slice(0, 2)).toEqual(["☑ research", "☑ produce"]);
    }));

  it("checks the work line of a done author without an artifact", () =>
    withAuthorStatus("done")((workflow) => {
      expect(checklistOf(workflow)).toEqual(["☑ research", "☑ produce"]);
    }));

  it("lists the head of each todo list up to the cap and counts the rest", () =>
    withAuthorStatus("working")((workflow) => {
      workflow.store.setTodos(researcherOf(workflow).task_id, { entries: RESEARCH_TODOS });
      workflow.store.setTodos(authorOf(workflow).task_id, {
        entries: pendingTodos(BOARD_MAX_ENTRIES + 2),
      });
      expect(checklistOf(workflow)).toEqual([
        "☑ Read the request",
        "☑ Map the login module",
        "☐ Write the payload ← working",
        ...pendingTodos(BOARD_MAX_ENTRIES).map((entry) => `☐ ${entry.content}`),
        "+2 more",
      ]);
    }));
});
