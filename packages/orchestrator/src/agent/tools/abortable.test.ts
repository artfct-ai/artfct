import { tool, type ToolSet } from "ai";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { abortableTools } from "./abortable";

const STOPPED = new Error("turn deadline");

function stuckTools(): ToolSet {
  return {
    stuck: tool({
      inputSchema: z.object({}),
      execute: () => new Promise<string>(() => undefined),
    }),
    quick: tool({
      inputSchema: z.object({}),
      execute: async () => "done",
    }),
  };
}

async function call(tools: ToolSet, name: string, abortSignal: AbortSignal): Promise<unknown> {
  return tools[name]!.execute!(
    {},
    { toolCallId: "call-1", messages: [], context: {}, abortSignal },
  );
}

describe("abortableTools", () => {
  describe("a call that never returns", () => {
    it("rejects with the abort reason once the turn aborts", async () => {
      const controller = new AbortController();
      const pending = call(abortableTools(stuckTools()), "stuck", controller.signal);
      controller.abort(STOPPED);
      await expect(pending).rejects.toBe(STOPPED);
    });
  });

  describe("a call made after the turn aborted", () => {
    it("rejects at once", async () => {
      const pending = call(abortableTools(stuckTools()), "stuck", AbortSignal.abort(STOPPED));
      await expect(pending).rejects.toBe(STOPPED);
    });
  });

  describe("a call that returns", () => {
    it("gives its result", async () => {
      const result = call(abortableTools(stuckTools()), "quick", new AbortController().signal);
      expect(await result).toBe("done");
    });
  });
});
