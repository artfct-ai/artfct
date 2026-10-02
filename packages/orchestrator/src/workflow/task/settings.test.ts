import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import {
  MODEL_AUTHOR_MODEL,
  patchModelExecution,
  patchStageResearch,
  patchStageReviewers,
  seedReviewerRun,
  seedTask,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { taskSettings } from "./settings";

describe("taskSettings", () => {
  describe("an author", () => {
    const author = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow);
    });

    it("runs the produce activity of its stage", () =>
      author((workflow) => {
        const task = workflow.store.requireTask("wf_x.1");
        expect(taskSettings(workflow, task)).toEqual(workflow.stageForTask(task).author.produce);
      }));
  });

  describe("a model-call author", () => {
    const author = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      seedTask(workflow);
    });

    it("runs as a model call on the produce model", () =>
      author((workflow) => {
        const settings = taskSettings(workflow, workflow.store.requireTask("wf_x.1"));
        expect(settings).toMatchObject({ execution: "model", model: MODEL_AUTHOR_MODEL });
      }));
  });

  describe("a researcher", () => {
    const researcher = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      patchStageResearch(workflow);
      seedTask(workflow, { role: "researcher" });
    });

    it("runs the research step in a harness session", () =>
      researcher((workflow) => {
        const settings = taskSettings(workflow, workflow.store.requireTask("wf_x.1"));
        expect(settings).toMatchObject({
          execution: "harness",
          harness: "opencode",
          model: "mock",
          skill: "research",
        });
      }));
  });

  describe("a researcher whose stage no longer declares a research step", () => {
    const researcher = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      seedTask(workflow, { role: "researcher" });
    });

    it("runs the author's settings in a harness session", () =>
      researcher((workflow) => {
        const settings = taskSettings(workflow, workflow.store.requireTask("wf_x.1"));
        expect(settings).toMatchObject({
          execution: "harness",
          model: MODEL_AUTHOR_MODEL,
          skill: "design",
        });
      }));
  });

  describe("a reviewer run", () => {
    const reviewer = scenario(freshRuntime, async (workflow) => {
      seedReviewerRun(workflow);
    });

    it("runs its entry's skill in a harness session", () =>
      reviewer((workflow) => {
        const settings = taskSettings(workflow, workflow.store.requireTask("wf_x.2"));
        expect(settings).toMatchObject({ execution: "harness", skill: "implement-review" });
      }));
  });

  describe("a reviewer run whose entry the config dropped", () => {
    const reviewer = scenario(freshRuntime, async (workflow) => {
      seedReviewerRun(workflow);
      patchStageReviewers(workflow, []);
    });

    it("runs the author's skill in a harness session", () =>
      reviewer((workflow) => {
        const settings = taskSettings(workflow, workflow.store.requireTask("wf_x.2"));
        expect(settings).toMatchObject({ execution: "harness", skill: "implement" });
      }));
  });
});
