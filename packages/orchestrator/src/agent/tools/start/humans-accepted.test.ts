import { describe, expect, it } from "bun:test";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { FakeRuntime } from "../../../../test/fake-runtime";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { acceptedAt, humansAccepted, HUMANS_ACCEPTED_PURPOSE } from "./humans-accepted";

const PAGE = "https://notion.so/doc";

function decisionsSay(workflow: FakeRuntime, accepts: number | Error): FakeDecisions {
  const decisions = new FakeDecisions(accepts instanceof Error ? accepts : { accepts });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

describe("acceptedAt", () => {
  it("is true at the floor", () => {
    expect(acceptedAt(0.7)).toBe(true);
  });

  it("is false when the decisions model is unsure", () => {
    expect(acceptedAt(0.5)).toBe(false);
  });
});

describe("humansAccepted", () => {
  it("shows the decisions model the artifact and every message of the turn", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsSay(workflow, 0.9);
      await humansAccepted(workflow, PAGE, ["Looks good.", "Go on."]);
      expect(decisions.asked).toEqual([{ artifact: PAGE, messages: "Looks good.\n\nGo on." }]);
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      await humansAccepted(workflow, PAGE, ["Looks good."]);
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([
        HUMANS_ACCEPTED_PURPOSE,
      ]);
    }));

  it("is null when the decisions model fails", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, new Error("unavailable"));
      expect(await humansAccepted(workflow, PAGE, ["Looks good."])).toBeNull();
    }));

  it("is null when the gateway carries no decisions model", () =>
    freshRuntime(async (workflow) => {
      expect(await humansAccepted(workflow, PAGE, ["Looks good."])).toBeNull();
    }));
});
