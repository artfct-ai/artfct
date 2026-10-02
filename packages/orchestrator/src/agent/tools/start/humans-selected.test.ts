import { describe, expect, it } from "bun:test";
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

function decisionsSay(workflow: FakeRuntime, selects: number | Error): FakeDecisions {
  const decisions = new FakeDecisions(selects instanceof Error ? selects : { selects });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

describe("humansSelected", () => {
  it("shows the decisions model the option, the numbered options, and every message of the turn", () =>
    freshRuntime(async (workflow) => {
      const decisions = decisionsSay(workflow, 0.9);
      await humansSelected(workflow, SELECTION);
      expect(decisions.asked).toEqual([
        {
          option: "Split the table",
          options: "1. Keep one table\n2. Split the table",
          messages: "Go with the second one.\n\nThanks.",
        },
      ]);
    }));

  it("is true when the decisions model is sure", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      expect(await humansSelected(workflow, SELECTION)).toBe(true);
    }));

  it("is false when the decisions model is unsure", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.5);
      expect(await humansSelected(workflow, SELECTION)).toBe(false);
    }));

  it("records the usage under its purpose", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, 0.9);
      await humansSelected(workflow, SELECTION);
      expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual([
        HUMANS_SELECTED_PURPOSE,
      ]);
    }));

  it("is null when the decisions model fails", () =>
    freshRuntime(async (workflow) => {
      decisionsSay(workflow, new Error("unavailable"));
      expect(await humansSelected(workflow, SELECTION)).toBeNull();
    }));

  it("is null when the gateway carries no decisions model", () =>
    freshRuntime(async (workflow) => {
      expect(await humansSelected(workflow, SELECTION)).toBeNull();
    }));
});
