import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { ScriptedFailure } from "../../../test/fake-model";
import { scenario } from "../../../test/scenario";
import { condensedMarker } from "../tools/condensed";
import { runAgentTurn } from "./turn";

const LARGE_TOKENS = 2000;

describe("an agent turn whose tool returns a result over the limit", () => {
  const turned = scenario(freshDurableRuntime, async (workflow) => {
    workflow.modelInstance = new ScriptedFailure(["call", "text", "silent"]);
    workflow.mcpToolSet = {
      ping: tool({
        inputSchema: z.object({}),
        execute: () => Promise.resolve("x".repeat(LARGE_TOKENS * 4)),
      }),
    };
    const config = workflow.config();
    workflow.patchConfig({ orchestrator: { ...config.orchestrator, context_tokens: 1000 } });
    workflow.transcript.enqueue("[note]\na page changed", "task_result");
    await runAgentTurn(workflow);
  });

  it("stores the condensed result, the same text the model read", () =>
    turned((workflow) => {
      const results = workflow.transcript
        .all()
        .flatMap((row) => (row.message.role === "tool" ? row.message.content : []))
        .flatMap((part) => (part.type === "tool-result" ? [part.output] : []));
      expect(results).toContainEqual({
        type: "text",
        value: `${condensedMarker(LARGE_TOKENS)}\ndone`,
      });
    }));
});
