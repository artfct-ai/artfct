import { describe, expect, it } from "bun:test";
import type { Choice } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { FakeRuntime } from "../../../../test/fake-runtime";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { HUMANS_SELECTED_PURPOSE, humansSelected } from "./humans-selected";

const SELECTION = {
  option: "Split the table",
  options: ["Keep one table", "Split the table"],
  messages: ["Go with the second one.", "Thanks."],
};

function decisionsPick(workflow: FakeRuntime, selected: Choice | Error): FakeDecisions {
  const decisions =
    selected instanceof Error ? new FakeDecisions(selected) : new FakeDecisions({}, { selected });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

describe("humansSelected", () => {
  it("shows the decisions model every message of the turn", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsPick(workflow, { option: "Split the table", probability: 0.9 });
      await humansSelected(workflow, SELECTION);
      expect(decisions.asked).toEqual([{ messages: "Go with the second one.\n\nThanks." }]);
    }));

  it("offers every listed option by its number, and an option for none of them", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsPick(workflow, { option: "Split the table", probability: 0.9 });
      await humansSelected(workflow, SELECTION);
      expect(Object.entries(decisions.offered[0]!.options).slice(0, 2)).toEqual([
        ["Keep one table", "Option 1."],
        ["Split the table", "Option 2."],
      ]);
      expect(Object.keys(decisions.offered[0]!.options)).toContain("none");
    }));

  it("is true when the decisions model is sure the person picked the option", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, { option: "Split the table", probability: 0.9 });
      expect(await humansSelected(workflow, SELECTION)).toBe(true);
    }));

  it("is false when the decisions model is unsure", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, { option: "Split the table", probability: 0.5 });
      expect(await humansSelected(workflow, SELECTION)).toBe(false);
    }));

  it("is false when the person picked another option", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, { option: "Keep one table", probability: 0.95 });
      expect(await humansSelected(workflow, SELECTION)).toBe(false);
    }));

  it("is false when the person picked none of them", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, { option: "none", probability: 0.95 });
      expect(await humansSelected(workflow, SELECTION)).toBe(false);
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, { option: "Split the table", probability: 0.9 });
      await humansSelected(workflow, SELECTION);
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([
        HUMANS_SELECTED_PURPOSE,
      ]);
    }));

  it("is null when the decisions model fails", () =>
    freshRuntime(async (workflow) => {
      decisionsPick(workflow, new Error("unavailable"));
      expect(await humansSelected(workflow, SELECTION)).toBeNull();
    }));
});
