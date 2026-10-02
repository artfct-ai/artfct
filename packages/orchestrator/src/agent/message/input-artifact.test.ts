import { describe, expect, it } from "bun:test";
import type { ArtifactKind } from "@artfct-ai/contracts/types";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { inputArtifactFrom, inputArtifactQuestion, stageAfterInput } from "./input-artifact";

function withStages(workflow: FakeRuntime, stages: [string, ArtifactKind][]): void {
  const [template] = workflow.workflowDefinition().stages;
  if (!template) throw new Error("the test config has no stage");
  workflow.patchWorkflowDefinition({
    stages: stages.map(([name, artifact]) => ({ ...template, name, artifact })),
  });
}

const PAGE_ISSUES_PULL: [string, ArtifactKind][] = [
  ["sketch", "page"],
  ["outline", "page"],
  ["split", "issues"],
  ["build", "pull"],
];

const configured = (run: (workflow: FakeRuntime) => void) =>
  freshRuntime(async (workflow) => {
    withStages(workflow, PAGE_ISSUES_PULL);
    run(workflow);
  });

describe("inputArtifactQuestion", () => {
  it("offers the kinds the stages produce, then the option for none", () =>
    freshRuntime(async (workflow) => {
      withStages(workflow, [
        ["sketch", "page"],
        ["outline", "page"],
        ["build", "pull"],
      ]);
      expect(
        Object.keys(inputArtifactQuestion(workflow.workflowDefinition().stages).options),
      ).toEqual(["page", "pull", "none"]);
    }));
});

describe("inputArtifactFrom", () => {
  it("returns the kind of a clear pick", () => {
    expect(inputArtifactFrom({ option: "issues", probability: 0.92 })).toBe("issues");
  });

  it("returns null for a pick of none", () => {
    expect(inputArtifactFrom({ option: "none", probability: 0.95 })).toBeNull();
  });

  it("returns null for a pick below the threshold", () => {
    expect(inputArtifactFrom({ option: "page", probability: 0.65 })).toBeNull();
  });
});

describe("stageAfterInput", () => {
  it("returns the stage after the last stage that produces the kind", () =>
    configured((workflow) => {
      expect(stageAfterInput(workflow.workflowDefinition().stages, "page")).toBe("split");
      expect(stageAfterInput(workflow.workflowDefinition().stages, "issues")).toBe("build");
    }));

  it("returns null when no stage follows the producer", () =>
    configured((workflow) => {
      expect(stageAfterInput(workflow.workflowDefinition().stages, "pull")).toBeNull();
    }));

  it("returns null when no stage produces the kind", () =>
    freshRuntime(async (workflow) => {
      withStages(workflow, [["build", "pull"]]);
      expect(stageAfterInput(workflow.workflowDefinition().stages, "issues")).toBeNull();
    }));
});
