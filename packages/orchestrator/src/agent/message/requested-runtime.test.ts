import { describe, expect, it } from "bun:test";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { ANTHROPIC_MODELS, OPENROUTER_MODELS } from "../../../test/model-lists";
import {
  chooseRequestedRuntime,
  modelFamily,
  modelOffers,
  modelSources,
  REQUESTED_RUNTIME_PURPOSE,
  runtimeForModel,
} from "./requested-runtime";

const SOURCES = modelSources(
  [
    { harness: "claude-code", list: { vendor: "anthropic", models: ANTHROPIC_MODELS } },
    { harness: "opencode", list: null },
    { harness: "opencode", list: null },
  ],
  OPENROUTER_MODELS,
);

function offeredIds(message: string): string[] {
  return modelOffers(message, SOURCES).map((offer) => offer.id);
}

function decisionsPick(workflow: FakeRuntime, option: string | Error): FakeDecisions {
  const decisions =
    option instanceof Error
      ? new FakeDecisions(option)
      : new FakeDecisions({}, { model: { option, probability: 0.8 } });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

describe("modelSources", () => {
  it("leaves a gateway model to the harness that runs its vendor by its own ids", () => {
    const ids = SOURCES.models.map((model) => model.id);
    expect(ids).toContain("claude-opus-5-5");
    expect(ids.some((id) => id.startsWith("openrouter/anthropic/"))).toBe(false);
  });

  it("runs every gateway model on the gateway harness", () => {
    const glm = SOURCES.models.find((model) => model.id === "openrouter/z-ai/glm-5.3");
    expect(glm?.harness).toBe("opencode");
  });

  it("keeps the presets apart from the models", () => {
    expect(SOURCES.presets.map((preset) => preset.id)).toEqual([
      "openrouter/@preset/deepseek-v4-1-flash",
      "openrouter/@preset/glm5-3",
    ]);
  });
});

describe("modelFamily", () => {
  it("drops the version segments of an Anthropic id", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("claude-opus");
  });

  it("drops a dotted version inside a gateway id", () => {
    expect(modelFamily("openrouter/google/gemini-3.8-flash")).toBe(
      "openrouter/google/gemini-flash",
    );
  });

  it("keeps a variant apart from its base model", () => {
    expect(modelFamily("openrouter/z-ai/glm-5.3-flash")).not.toBe(
      modelFamily("openrouter/z-ai/glm-5.3"),
    );
  });
});

describe("modelOffers", () => {
  it("offers only the newest opus for opus", () => {
    const ids = offeredIds("use opus for this");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).not.toContain("claude-opus-4-8");
  });

  it("offers every opus release for opus 5.5", () => {
    const ids = offeredIds("run it on opus 5.5");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("claude-opus-5");
  });

  it("offers the Anthropic id for opus-5-5", () => {
    expect(offeredIds("opus-5-5 please")).toContain("claude-opus-5-5");
  });

  it("offers the newest fable for fable", () => {
    expect(offeredIds("try fable")).toEqual(["claude-fable-5-1"]);
  });

  it("offers the newest glm and the glm preset for glm", () => {
    const ids = offeredIds("do it with glm");
    expect(ids).toContain("openrouter/z-ai/glm-5.3");
    expect(ids).toContain("openrouter/@preset/glm5-3");
    expect(ids).not.toContain("openrouter/z-ai/glm-5.2");
  });

  it("offers glm 5.3 and the glm preset for glm 5.3", () => {
    const ids = offeredIds("use glm 5.3 for the implementation");
    expect(ids).toContain("openrouter/z-ai/glm-5.3");
    expect(ids).toContain("openrouter/@preset/glm5-3");
  });

  it("offers the newest gemini flash for gemini flash", () => {
    const ids = offeredIds("gemini flash");
    expect(ids).toContain("openrouter/google/gemini-3.8-flash");
    expect(ids).not.toContain("openrouter/google/gemini-2.5-flash");
  });

  it("offers nothing when no word names a model", () => {
    expect(offeredIds("fix the login bug")).toEqual([]);
  });
});

describe("runtimeForModel", () => {
  it("runs an Anthropic id on claude-code", () => {
    expect(runtimeForModel("claude-opus-5-5", SOURCES)).toEqual({
      harness: "claude-code",
      model: "claude-opus-5-5",
    });
  });

  it("runs the preset in place of the model it runs", () => {
    expect(runtimeForModel("openrouter/z-ai/glm-5.3", SOURCES)).toEqual({
      harness: "opencode",
      model: "openrouter/@preset/glm5-3",
    });
  });

  it("runs a picked preset on the gateway harness", () => {
    expect(runtimeForModel("openrouter/@preset/glm5-3", SOURCES)).toEqual({
      harness: "opencode",
      model: "openrouter/@preset/glm5-3",
    });
  });

  it("runs a gateway model with no preset as it is", () => {
    expect(runtimeForModel("openrouter/google/gemini-3.8-flash", SOURCES)).toEqual({
      harness: "opencode",
      model: "openrouter/google/gemini-3.8-flash",
    });
  });

  it("has no runtime for the none option", () => {
    expect(runtimeForModel("none", SOURCES)).toBeNull();
  });
});

describe("chooseRequestedRuntime", () => {
  it("offers the decisions model the narrowed models and a none option", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsPick(workflow, "claude-fable-5-1");
      await chooseRequestedRuntime(workflow, "try fable", SOURCES);
      expect(decisions.asked).toEqual([{ message: "try fable" }]);
      expect(Object.keys(decisions.offered[0]!.options)).toEqual(["claude-fable-5-1", "none"]);
    }));

  it("resolves glm to the latency optimized preset", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, "openrouter/z-ai/glm-5.3");
      expect(await chooseRequestedRuntime(workflow, "do it with glm", SOURCES)).toEqual({
        kind: "resolved",
        runtime: { harness: "opencode", model: "openrouter/@preset/glm5-3" },
      });
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, "claude-opus-5-5");
      await chooseRequestedRuntime(workflow, "use opus", SOURCES);
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([
        REQUESTED_RUNTIME_PURPOSE,
      ]);
    }));

  it("names the closest models when the decisions model picks none", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, "none");
      expect(await chooseRequestedRuntime(workflow, "try fable", SOURCES)).toEqual({
        kind: "unresolved",
        closest: ["claude-fable-5-1"],
      });
    }));

  it("names the closest models when the decisions call fails", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, new Error("down"));
      expect(await chooseRequestedRuntime(workflow, "try fable", SOURCES)).toEqual({
        kind: "unresolved",
        closest: ["claude-fable-5-1"],
      });
    }));

  it("asks nothing when no word names a model", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsPick(workflow, "claude-opus-5-5");
      expect(await chooseRequestedRuntime(workflow, "fix the login bug", SOURCES)).toEqual({
        kind: "unresolved",
        closest: [],
      });
      expect(decisions.asked).toEqual([]);
    }));
});
