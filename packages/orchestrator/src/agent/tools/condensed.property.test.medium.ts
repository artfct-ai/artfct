import { tool } from "ai";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { EchoModel, ScriptedFailure } from "../../../test/fake-model";
import { estimatedTokens } from "../transcript/transcript-size";
import { condensingTools } from "./condensed";

const CALL = { toolCallId: "call-1", messages: [], context: {} };
const LIMIT = 100;
const SHORTENED = /^\[(condensed result|result too large)\] /;

const resultText = fc.integer({ min: 0, max: LIMIT * 8 }).map((chars) => "x".repeat(chars));
const result = fc.oneof(
  resultText,
  resultText.map((body) => ({ body })),
);
const summarization = fc.constantFrom("answers", "fails");

describe("condensingTools", () => {
  it("returns a result under the limit whole, and any other under a first line that says it was shortened", () =>
    freshDurableRuntime(async (workflow) => {
      const config = workflow.config();
      workflow.patchConfig({
        orchestrator: { ...config.orchestrator, model: "reasoning-model", context_tokens: LIMIT },
      });
      await fc.assert(
        fc.asyncProperty(result, summarization, async (returned, outcome) => {
          workflow.modelsByName = {
            "reasoning-model":
              outcome === "answers" ? new EchoModel("Short.") : new ScriptedFailure(["throw"]),
          };
          const { search } = condensingTools(workflow, {
            search: tool({ inputSchema: z.object({}), execute: () => Promise.resolve(returned) }),
          });
          const read: unknown = await search!.execute!({}, CALL);
          const text = typeof returned === "string" ? returned : JSON.stringify(returned);
          if (estimatedTokens(text) <= LIMIT) expect(read).toBe(returned);
          else expect(String(read)).toMatch(SHORTENED);
        }),
      );
    }));
});
