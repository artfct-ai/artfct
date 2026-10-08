import { describe, expect, it } from "bun:test";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { OPTIONS_HEADING } from "../../../artifact/options";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { patchModelExecution, seedTask, type FakeRuntime } from "../../../../test/fake-runtime";
import { scenario } from "../../../../test/scenario";
import { toolText } from "../../../../test/tool-result";
import type { RuntimeRequest } from "../../message/requested-runtime";
import { documentHostRefusal, slotRefusal, startTools, withRequestedRuntime } from "./start";

const call = { toolCallId: "call-1", messages: [], context: {} };

const cancelled = scenario(freshRuntime, (workflow) => {
  seedTask(workflow, { task_id: "wf_x.1", status: "cancelled" });
});

const researching = scenario(freshRuntime, (workflow) => {
  seedTask(workflow, { task_id: "wf_x.1", role: "researcher" });
});

describe("complete_job", () => {
  describe("a job whose researcher still works", () => {
    it("refuses because the job has no artifact yet", () =>
      researching(async (workflow) => {
        const { complete_job } = startTools(workflow);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          "Job wf_x-1 has no artifact yet: its researcher task wf_x.1 is working. Wait for its author task.",
        );
      }));

    it("leaves the researcher working", () =>
      researching(async (workflow) => {
        const { complete_job } = startTools(workflow);
        await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("working");
      }));
  });

  it("refuses a job that does not exist", () =>
    freshRuntime(async (workflow) => {
      const { complete_job } = startTools(workflow);
      expect(await complete_job.execute({ job_id: "wf_x-9", result: "Done." }, call)).toBe(
        "Job wf_x-9 does not exist.",
      );
    }));

  describe("a cancelled job", () => {
    it("refuses and says the status", () =>
      cancelled(async (workflow) => {
        const { complete_job } = startTools(workflow);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          "Job wf_x-1 is already over: its author task is cancelled. A finished task keeps its status.",
        );
      }));

    it("leaves the author cancelled", () =>
      cancelled(async (workflow) => {
        const { complete_job } = startTools(workflow);
        await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("cancelled");
      }));
  });

  describe("a page, which only the humans accept", () => {
    const PAGE = "https://notion.so/doc";
    const REFUSED_UNCLEAR =
      "The person's message does not clearly accept the page of job wf_x-1. Ask them whether it is accepted. " +
      "Send a change they asked for to the author task with prompt_task.";

    const pageInReview = (accepts: number | null) =>
      scenario(freshRuntime, (workflow) => {
        seedTask(workflow, { task_id: "wf_x.1", status: "in_review" });
        workflow.store.upsertArtifact({
          job_id: "wf_x-1",
          kind: "page",
          external_url: PAGE,
          ref: { kind: "issues" },
        });
        if (accepts === null) return;
        workflow.gatewayInstance = new FakeGateway({
          decisions: new FakeDecisions({ accepts }),
        });
      });

    it("refuses when no person wrote in this turn", () =>
      pageInReview(0.9)(async (workflow) => {
        const { complete_job } = startTools(workflow);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          "Only the humans accept the page of job wf_x-1, and no person wrote in this turn. Wait for their reply.",
        );
      }));

    it("refuses when the person's message does not accept it", () =>
      pageInReview(0.2)(async (workflow) => {
        const { complete_job } = startTools(workflow, ["Why two tables?"]);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          REFUSED_UNCLEAR,
        );
      }));

    it("refuses when the decisions model is unsure", () =>
      pageInReview(0.5)(async (workflow) => {
        const { complete_job } = startTools(workflow, ["Hm, maybe."]);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          REFUSED_UNCLEAR,
        );
      }));

    it("leaves the author of a refused job in review", () =>
      pageInReview(0.2)(async (workflow) => {
        const { complete_job } = startTools(workflow, ["Why two tables?"]);
        await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));

    it("completes the job when the person's message accepts it", () =>
      pageInReview(0.9)(async (workflow) => {
        const { complete_job } = startTools(workflow, ["Looks good, ship it."]);
        await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("done");
      }));

    it("says the check is unavailable when no decisions model answers", () =>
      pageInReview(null)(async (workflow) => {
        const { complete_job } = startTools(workflow, ["Looks good, ship it."]);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          "The check of whether the person accepted the page of job wf_x-1 is unavailable right now, so the job stays open. Tell the person the check is unavailable. Do not ask them again.",
        );
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));

    it("names the next stage of the plan", () =>
      pageInReview(0.9)(async (workflow) => {
        workflow.patchState({ stages: ["design", "implement"] });
        const { complete_job } = startTools(workflow, ["Looks good, ship it."]);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          "Job wf_x-1 done. Next stage: implement. Call start_job with stage implement and a brief for it.",
        );
      }));

    it("names no next stage for a job whose stage is outside the plan", () =>
      pageInReview(0.9)(async (workflow) => {
        workflow.patchState({ stages: ["breakdown", "implement"] });
        const { complete_job } = startTools(workflow, ["Looks good, ship it."]);
        expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
          "Job wf_x-1 done. Stage design is not in the plan, so the plan names no next stage. Call set_plan when the route changed.",
        );
      }));
  });
});

function endDesignOnChoice(workflow: FakeRuntime): void {
  workflow.patchWorkflowDefinition({
    stages: workflow
      .workflowDefinition()
      .stages.map((stage) =>
        stage.name === "design" ? { ...stage, ending: "choice" as const } : stage,
      ),
  });
}

describe("complete_job on a stage with a choice ending", () => {
  const PAGE_TEXT = [
    "# Sessions",
    "",
    `## ${OPTIONS_HEADING}`,
    "",
    "1. Keep one table",
    "2. Split the table",
  ].join("\n");
  const PICKED = ["Go with splitting the table."];

  const pageWithOptions = (probability: number | null) =>
    scenario(freshRuntime, async (workflow) => {
      endDesignOnChoice(workflow);
      const documents = new FakeDocuments();
      workflow.documentsInstance = documents;
      const page = await documents.createPage("Sessions", PAGE_TEXT, "parent-1");
      seedTask(workflow, { task_id: "wf_x.1", status: "in_review" });
      workflow.store.upsertArtifact({
        job_id: "wf_x-1",
        kind: "page",
        external_url: page.url,
        ref: { kind: "page", page_id: page.id },
      });
      if (probability === null) return;
      const selected = { option: "Split the table", probability };
      workflow.gatewayInstance = new FakeGateway({
        decisions: new FakeDecisions({}, { selected }),
      });
    });

  it("refuses when the agent names no option", () =>
    pageWithOptions(0.9)(async (workflow) => {
      const { complete_job } = startTools(workflow, PICKED);
      expect(await complete_job.execute({ job_id: "wf_x-1", result: "Done." }, call)).toBe(
        "Stage design ends on a choice. Pass the option a person selected, as the page of job wf_x-1 lists it.",
      );
      expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
    }));

  it("refuses when no person wrote in this turn", () =>
    pageWithOptions(0.9)(async (workflow) => {
      const { complete_job } = startTools(workflow);
      expect(
        await complete_job.execute(
          { job_id: "wf_x-1", result: "Done.", option: "Split the table" },
          call,
        ),
      ).toBe(
        "Stage design ends on a choice, and no person wrote in this turn. Wait for a person to select an option.",
      );
    }));

  it("refuses an option the page does not list", () =>
    pageWithOptions(0.9)(async (workflow) => {
      const { complete_job } = startTools(workflow, PICKED);
      expect(
        await complete_job.execute(
          { job_id: "wf_x-1", result: "Done.", option: "Drop the table" },
          call,
        ),
      ).toBe(
        'The page of job wf_x-1 lists no option "Drop the table" under its options heading. It lists: "Keep one table", "Split the table".',
      );
      expect(workflow.store.requireJob("wf_x-1").selection).toBeNull();
    }));

  it("refuses when the person's message does not select the option", () =>
    pageWithOptions(0.2)(async (workflow) => {
      const { complete_job } = startTools(workflow, ["Why two tables?"]);
      expect(
        await complete_job.execute(
          { job_id: "wf_x-1", result: "Done.", option: "Split the table" },
          call,
        ),
      ).toBe(
        'The person\'s message does not clearly select "Split the table". Ask them which option they choose.',
      );
      expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
    }));

  it("says the check is unavailable when no decisions model answers", () =>
    pageWithOptions(null)(async (workflow) => {
      const { complete_job } = startTools(workflow, PICKED);
      const result = await complete_job.execute(
        { job_id: "wf_x-1", result: "Done.", option: "Split the table" },
        call,
      );
      expect(result).toBe(
        'The check of whether the person selected "Split the table" is unavailable right now, so the job stays open. Tell the person the check is unavailable. Do not ask them again.',
      );
      expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      expect(workflow.store.requireJob("wf_x-1").selection).toBeNull();
    }));

  describe("once the person's message selects a listed option", () => {
    const selected = scenario(pageWithOptions(0.9), async (workflow) => {
      const { complete_job } = startTools(workflow, PICKED);
      await complete_job.execute(
        { job_id: "wf_x-1", result: "Done.", option: "Split the table" },
        call,
      );
    });

    it("stores the selection on the job", () =>
      selected((workflow) => {
        expect(workflow.store.requireJob("wf_x-1").selection).toBe("Split the table");
      }));

    it("completes the job", () =>
      selected((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("done");
      }));
  });
});

describe("cancel_job", () => {
  describe("a running job with a queued prompt", () => {
    let result: string;
    const cancelledNow = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1" });
      workflow.store.enqueuePrompt("wf_x.1", "pending");
      const { cancel_job } = startTools(workflow);
      result = toolText(await cancel_job.execute({ job_id: "wf_x-1", reason: "wrong repo" }, call));
    });

    it("answers that the job is cancelled", () =>
      cancelledNow(() => {
        expect(result).toBe("Cancelled job wf_x-1.");
      }));

    it("finishes the author task as cancelled", () =>
      cancelledNow((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("cancelled");
      }));

    it("drops the queued prompt", () =>
      cancelledNow((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("drops the sandbox", () =>
      cancelledNow((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual(["destroy wf_x.1"]);
      }));

    it("leaves the workflow open", () =>
      cancelledNow((workflow) => {
        expect(workflow.state.status).toBe("running");
      }));

    it("tells the agent why the job ended", () =>
      cancelledNow((workflow) => {
        expect(workflow.noteTexts().join("\n")).toContain("Job wf_x-1 was cancelled: wrong repo");
      }));
  });

  describe("a job whose researcher still works", () => {
    let result: string;
    const cancelledNow = scenario(researching, async (workflow) => {
      const { cancel_job } = startTools(workflow);
      result = toolText(await cancel_job.execute({ job_id: "wf_x-1", reason: "wrong repo" }, call));
    });

    it("answers that the job is cancelled", () =>
      cancelledNow(() => {
        expect(result).toBe("Cancelled job wf_x-1.");
      }));

    it("finishes the researcher task as cancelled", () =>
      cancelledNow((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("cancelled");
      }));

    it("tells the agent why the job ended", () =>
      cancelledNow((workflow) => {
        expect(workflow.noteTexts().join("\n")).toContain("Job wf_x-1 was cancelled: wrong repo");
      }));
  });

  it("refuses a job that is already over", () =>
    cancelled(async (workflow) => {
      const { cancel_job } = startTools(workflow);
      expect(await cancel_job.execute({ job_id: "wf_x-1", reason: "not needed" }, call)).toBe(
        "Job wf_x-1 is already over: its author task is cancelled.",
      );
    }));
});

describe("slotRefusal", () => {
  it("counts a job whose researcher holds its slot", () =>
    researching((workflow) => {
      workflow.patchState({ concurrency: 1 });
      expect(slotRefusal(workflow)).toBe(
        "All 1 slots are busy (wf_x-1). Wait for a job to complete.",
      );
    }));

  it("lets a job start into a free slot", () =>
    researching((workflow) => {
      workflow.patchState({ concurrency: 2 });
      expect(slotRefusal(workflow)).toBeNull();
    }));
});

const modelStage = scenario(freshRuntime, (workflow) => {
  patchModelExecution(workflow);
});

describe("documentHostRefusal", () => {
  describe("a stage with model execution", () => {
    it("lets the job start with a document host", () =>
      modelStage(async (workflow) => {
        expect(await documentHostRefusal(workflow, "design")).toBeNull();
      }));

    it("refuses when the workflow has no document host", () =>
      modelStage(async (workflow) => {
        workflow.documentsInstance = null;
        expect(await documentHostRefusal(workflow, "design")).toBe(
          "Stage design writes its page on the document host, and this workflow has none.",
        );
      }));
  });

  describe("a stage with a choice ending", () => {
    const choiceEndingStage = scenario(freshRuntime, (workflow) => {
      endDesignOnChoice(workflow);
    });

    it("refuses when the workflow has no document host", () =>
      choiceEndingStage(async (workflow) => {
        expect(await documentHostRefusal(workflow, "design")).toBe(
          "Stage design ends on a choice read from its page on the document host, and this workflow has none.",
        );
      }));

    it("lets the job start with a document host", () =>
      choiceEndingStage(async (workflow) => {
        workflow.documentsInstance = new FakeDocuments();
        expect(await documentHostRefusal(workflow, "design")).toBeNull();
      }));
  });

  it("lets a stage with harness execution start with no document host", () =>
    freshRuntime(async (workflow) => {
      expect(await documentHostRefusal(workflow, "design")).toBeNull();
    }));
});

describe("start_job on a stage with model execution", () => {
  it("refuses when the workflow has no document host", () =>
    modelStage(async (workflow) => {
      workflow.documentsInstance = null;
      const { start_job } = startTools(workflow, ["Write the design."]);
      expect(await start_job.execute({ stage: "design", brief: "Write it." }, call)).toBe(
        "Stage design writes its page on the document host, and this workflow has none.",
      );
      expect(workflow.store.jobs()).toEqual([]);
    }));

  it("refuses a harness for the author", () =>
    modelStage(async (workflow) => {
      const { start_job } = startTools(workflow, ["Write the design."]);
      expect(
        await start_job.execute({ stage: "design", brief: "Write it.", harness: "opencode" }, call),
      ).toBe(
        "Stage design runs its author as one model call, with no harness. Start it without a harness.",
      );
    }));

  it("starts a job with a document host", () =>
    modelStage(async (workflow) => {
      const { start_job } = startTools(workflow, ["Write the design."]);
      expect(await start_job.execute({ stage: "design", brief: "Write it." }, call)).toBe(
        "Started job wf_x-1 for stage design. Its author task is wf_x.1.",
      );
    }));
});

const GLM_PRESET: RuntimeRequest = {
  kind: "resolved",
  runtime: { harness: "opencode", model: "openrouter/@preset/glm5-3" },
};

const OPUS: RuntimeRequest = {
  kind: "resolved",
  runtime: { harness: "claude-code", model: "claude-opus-5-5" },
};

function startRequesting(workflow: FakeRuntime, request: RuntimeRequest | null) {
  return startTools(workflow, ["Write the design."], { runtimeRequest: Promise.resolve(request) });
}

describe("start_job with a requested runtime", () => {
  it("runs the author on the requested runtime over the label args", () =>
    freshRuntime(async (workflow) => {
      const { start_job } = startRequesting(workflow, GLM_PRESET);
      const input = {
        stage: "design",
        brief: "Write it.",
        harness: "claude-code" as const,
        model: "claude-sonnet-5",
      };
      expect(await start_job.execute(input, call)).toEndWith(
        "Its author runs openrouter/@preset/glm5-3 on opencode, as the person asked.",
      );
      const job = workflow.store.requireJob("wf_x-1");
      expect([job.author_harness, job.author_model]).toEqual([
        "opencode",
        "openrouter/@preset/glm5-3",
      ]);
    }));

  it("says the job runs without the model when it matched none clearly", () =>
    freshRuntime(async (workflow) => {
      const { start_job } = startRequesting(workflow, {
        kind: "unresolved",
        closest: ["claude-fable-5-1"],
      });
      expect(await start_job.execute({ stage: "design", brief: "Write it." }, call)).toEndWith(
        "The person named a model that matched none clearly, so the job runs without it. The closest: claude-fable-5-1. Ask the person which model they meant.",
      );
      expect(workflow.store.requireJob("wf_x-1").author_model).toBeNull();
    }));

  it("starts on the stage's pair when no message named a model", () =>
    freshRuntime(async (workflow) => {
      const { start_job } = startRequesting(workflow, null);
      expect(await start_job.execute({ stage: "design", brief: "Write it." }, call)).toBe(
        "Started job wf_x-1 for stage design. Its author task is wf_x.1.",
      );
    }));
});

describe("withRequestedRuntime on a stage with model execution", () => {
  it("takes only the model of a gateway runtime", () =>
    modelStage((workflow) => {
      expect(
        withRequestedRuntime(workflow, { stage: "design", brief: "Write it." }, GLM_PRESET),
      ).toEqual({
        input: {
          stage: "design",
          brief: "Write it.",
          harness: undefined,
          model: "openrouter/@preset/glm5-3",
        },
        note: "Its author runs on openrouter/@preset/glm5-3, as the person asked.",
      });
    }));

  it("keeps the stage's model for a model only a harness runs", () =>
    modelStage((workflow) => {
      expect(withRequestedRuntime(workflow, { stage: "design", brief: "Write it." }, OPUS)).toEqual(
        {
          input: { stage: "design", brief: "Write it." },
          note: "Stage design runs its author as one model call on the gateway, and claude-opus-5-5 runs only on claude-code, so the job runs the stage's model.",
        },
      );
    }));
});
