import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../test/fresh-runtime";
import {
  MODEL_AUTHOR_MODEL,
  patchModelExecution,
  patchStageResearch,
  type FakeRuntime,
} from "../../test/fake-runtime";
import { scenario } from "../../test/scenario";
import { startAuthorAfterResearch, startJob } from "./lifecycle";

const start = (workflow: FakeRuntime) =>
  startJob(workflow, {
    stage: "implement",
    brief: "Fix the login redirect.",
    input: { kind: "request", text: "Fix the login redirect." },
    harness: "opencode",
    model: "override-model",
  });

const researchedAuthor = async (workflow: FakeRuntime) => {
  const researcher = workflow.store.tasks().find((task) => task.role === "researcher");
  await startAuthorAfterResearch(workflow, researcher!, "Findings.");
  return workflow.store.tasks().find((task) => task.role === "author");
};

describe("startJob", () => {
  describe("from the artifact of an earlier job", () => {
    const fromArtifact = scenario(freshRuntime, async (workflow) => {
      await startJob(workflow, {
        stage: "implement",
        brief: "Build the design.",
        input: { kind: "artifact", jobId: "wf_x-1" },
      });
    });

    it("records the earlier job as the preceding job", () =>
      fromArtifact((workflow) => {
        expect(workflow.store.jobs().at(-1)?.preceding_job_id).toBe("wf_x-1");
      }));
  });

  describe("from an artifact no job of this workflow produced", () => {
    const fromTarget = scenario(freshRuntime, async (workflow) => {
      await startJob(workflow, {
        stage: "implement",
        brief: "Build the design.",
        input: {
          kind: "target",
          target: { ref: { kind: "page", page_id: "page-7" }, url: "https://docs.test/page-7" },
        },
      });
    });

    it("records the artifact as the input of the job", () =>
      fromTarget((workflow) => {
        expect(workflow.store.jobs().at(-1)).toMatchObject({
          input_key: "page:page-7",
          input_ref: { kind: "page", page_id: "page-7" },
          input_url: "https://docs.test/page-7",
          preceding_job_id: null,
        });
      }));
  });

  describe("from a request", () => {
    it("records no preceding job and no input artifact", () =>
      freshRuntime(async (workflow) => {
        await start(workflow);
        expect(workflow.store.jobs().at(-1)).toMatchObject({
          preceding_job_id: null,
          input_ref: null,
          input_url: null,
        });
      }));
  });

  describe("on a stage with model execution", () => {
    const modelStage = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      await startJob(workflow, {
        stage: "design",
        brief: "Write the design.",
        input: { kind: "request", text: "Add SSO." },
      });
    });

    it("queues an author on the stage model", () =>
      modelStage((workflow) => {
        expect(workflow.store.tasks()).toMatchObject([
          { role: "author", status: "queued", model: MODEL_AUTHOR_MODEL },
        ]);
      }));

    it("gives the author no sandbox", () =>
      modelStage((workflow) => {
        const [author] = workflow.store.tasks();
        expect(workflow.store.sandbox(author!.task_id)).toBeNull();
      }));

    it("starts the author through the provision alarm", () =>
      modelStage((workflow) => {
        const [author] = workflow.store.tasks();
        expect(workflow.alarmsFor("provision").map((alarm) => alarm.payload)).toContainEqual({
          task_id: author?.task_id,
        });
      }));
  });

  describe("on a stage with a research step", () => {
    const researching = scenario(freshRuntime, async (workflow) => {
      patchStageResearch(workflow);
      await start(workflow);
    });

    it("starts a researcher on the research harness and model", () =>
      researching((workflow) => {
        const [researcher, ...others] = workflow.store.tasks();
        expect(others).toEqual([]);
        expect(researcher).toMatchObject({ role: "researcher", status: "queued", model: "mock" });
        expect(workflow.store.requireSandbox(researcher!.task_id).harness).toBe("opencode");
      }));

    it("provisions the researcher", () =>
      researching((workflow) => {
        const [researcher] = workflow.store.tasks();
        expect(workflow.alarmsFor("provision").map((alarm) => alarm.payload)).toContainEqual({
          task_id: researcher?.task_id,
        });
      }));

    it("starts no author yet", () =>
      researching((workflow) => {
        expect(workflow.store.tasks().filter((task) => task.role === "author")).toEqual([]);
      }));
  });

  describe("when the research step ends", () => {
    it("starts the author on the harness and model the agent named", () =>
      freshRuntime(async (workflow) => {
        patchStageResearch(workflow);
        await start(workflow);
        const author = await researchedAuthor(workflow);
        expect(author).toMatchObject({ status: "queued", model: "override-model" });
        expect(workflow.store.requireSandbox(author!.task_id).harness).toBe("opencode");
      }));

    it("starts the author on the stage harness and model when the agent named none", () =>
      freshRuntime(async (workflow) => {
        patchStageResearch(workflow);
        await startJob(workflow, {
          stage: "implement",
          brief: "Fix the login redirect.",
          input: { kind: "request", text: "Fix the login redirect." },
        });
        const author = await researchedAuthor(workflow);
        const stage = workflow.stageFor(workflow.store.requireJob(author!.job_id));
        expect(author).toMatchObject({ status: "queued", model: stage.author.produce.model });
        expect(workflow.store.requireSandbox(author!.task_id).harness).toBe(
          stage.author.produce.harness,
        );
      }));
  });

  describe("on a stage with no research step", () => {
    const authoring = scenario(freshRuntime, async (workflow) => {
      await start(workflow);
    });

    it("starts the author on the harness and model the agent named", () =>
      authoring((workflow) => {
        const [author, ...others] = workflow.store.tasks();
        expect(others).toEqual([]);
        expect(author).toMatchObject({ role: "author", status: "queued", model: "override-model" });
        expect(workflow.store.requireSandbox(author!.task_id).harness).toBe("opencode");
      }));
  });
});
