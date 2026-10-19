import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { ScriptedFailure } from "../../../test/fake-model";
import { scenario } from "../../../test/scenario";
import { runAgentTurn } from "./turn";

class ToolNamesSeen extends ScriptedFailure {
  readonly offered: string[][] = [];

  override async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    this.offered.push((options.tools ?? []).map((offered) => offered.name));
    return super.doGenerate(options);
  }
}

describe("an agent turn whose MCP tools fail to load", () => {
  let model: ToolNamesSeen;
  const turned = scenario(freshDurableRuntime, async (workflow) => {
    model = new ToolNamesSeen(["silent"]);
    workflow.modelInstance = model;
    workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions({}) });
    workflow.mcpTools = () => Promise.reject(new Error("mcp connect refused"));
    workflow.transcript.enqueue("[note]\na page changed", "task_result");
    await runAgentTurn(workflow);
  });

  it("logs the failure", () =>
    turned((workflow) => {
      expect(workflow.lines).toContainEqual(
        expect.stringContaining("mcp tools unavailable this turn: Error: mcp connect refused"),
      );
    }));

  it("runs the turn with the workflow tools", () =>
    turned(() => {
      expect(model.offered.length).toBeGreaterThan(0);
      expect(model.offered[0]).toContain("stay_silent");
      expect(model.offered[0]).not.toContain("ping");
    }));

  it("ends the turn as the model chose, without a failure post", () =>
    turned((workflow) => {
      expect(workflow.posted.map((event) => event.type)).not.toContain("turn_failed");
      expect(workflow.lines).not.toContainEqual(expect.stringContaining("agent turn failed"));
    }));
});
