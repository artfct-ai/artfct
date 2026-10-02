import { tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { EchoModel, ScriptedFailure } from "../../../test/fake-model";
import type { FakeRuntime } from "../../../test/fake-runtime";
import type { Scenario } from "../../../test/scenario";
import { CONDENSE_PROMPT } from "../../prompts/summarization-prompt";
import { condensedMarker, condensingTools, tooLargeText } from "./condensed";

const CALL = { toolCallId: "call-1", messages: [], context: {} };
const LIMIT = 1000;
const LARGE_TOKENS = 2000;
const LARGE_TEXT = "x".repeat(LARGE_TOKENS * 4);

function toolsReturning(result: unknown): ToolSet {
  return {
    search: tool({ inputSchema: z.object({}), execute: () => Promise.resolve(result) }),
    described: tool({ inputSchema: z.object({}) }),
  };
}

type Called = { workflow: FakeRuntime; result: unknown };

function calledWith(
  result: unknown,
  newModel: () => EchoModel | ScriptedFailure,
): Scenario<Called> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      workflow.modelsByName = { "reasoning-model": newModel() };
      const config = workflow.config();
      workflow.patchConfig({
        orchestrator: { ...config.orchestrator, model: "reasoning-model", context_tokens: LIMIT },
      });
      const { search } = condensingTools(workflow, toolsReturning(result));
      await run({ workflow, result: await search!.execute!({}, CALL) });
    });
}

describe("condensingTools", () => {
  describe("a result under the limit", () => {
    let model: EchoModel;
    const small = { items: ["ENG-1", "ENG-2"] };
    const called = calledWith(small, () => {
      model = new EchoModel("never used");
      return model;
    });

    it("reaches the model as the tool returned it", () =>
      called(({ result }) => {
        expect(result).toBe(small);
      }));

    it("asks no model", () =>
      called(() => {
        expect(model.systems).toEqual([]);
      }));
  });

  describe("a text result over the limit", () => {
    let model: EchoModel;
    const called = calledWith(LARGE_TEXT, () => {
      model = new EchoModel("40 issues, ENG-1 to ENG-40. Left out: descriptions.");
      return model;
    });

    it("is replaced by its summarization under a marker that says so", () =>
      called(({ result }) => {
        expect(result).toBe(
          `${condensedMarker(LARGE_TOKENS)}\n40 issues, ENG-1 to ENG-40. Left out: descriptions.`,
        );
      }));

    it("runs the condense prompt", () =>
      called(() => {
        expect(model.systems).toEqual([CONDENSE_PROMPT.system]);
      }));

    it("says so in the log", () =>
      called(({ workflow }) => {
        expect(workflow.lines).toContain("agent: search result of about 2000 tokens condensed");
      }));
  });

  describe("a JSON result over the limit", () => {
    const called = calledWith({ body: LARGE_TEXT }, () => new EchoModel("One page about parsers."));

    it("is condensed from its JSON text", () =>
      called(({ result }) => {
        expect(String(result).endsWith("\nOne page about parsers.")).toBe(true);
      }));
  });

  describe("a result over the limit that no model could condense", () => {
    const called = calledWith(LARGE_TEXT, () => new ScriptedFailure(["throw"]));

    it("is withheld, and the model is told to ask for less", () =>
      called(({ result }) => {
        expect(result).toBe(tooLargeText(LARGE_TOKENS));
      }));

    it("says so in the log", () =>
      called(({ workflow }) => {
        expect(workflow.lines).toContain(
          "agent: search result of about 2000 tokens withheld, no summary",
        );
      }));
  });

  describe("a tool with nothing to execute", () => {
    it("is passed through as it is", () =>
      freshDurableRuntime((workflow) => {
        const tools = toolsReturning("x");
        expect(condensingTools(workflow, tools).described).toBe(tools.described);
      }));
  });
});
