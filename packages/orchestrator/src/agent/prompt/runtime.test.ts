import { Config } from "../../config/config";
import { describe, expect, it } from "bun:test";
import { runtimeLines } from "./runtime";

function config(patch: Record<string, unknown> = {}): Config {
  return Config.parse({
    providers: { gateway: "openrouter" },
    orchestrator: {
      model: "openrouter/x-ai/grok-4.6",
      summarization: { model: "openrouter/minimax/minimax-m3" },
    },
    ...patch,
  });
}

describe("runtimeLines", () => {
  describe("a config that names gateway models", () => {
    const lines = runtimeLines(config());

    it("heads the block", () => {
      expect(lines[0]).toBe("## Harnesses and models");
    });

    it("names every harness", () => {
      expect(lines[1]).toBe("Harnesses: claude-code, opencode.");
    });

    it("names the gateway and gives each config model once as an example", () => {
      expect(lines[3]).toBe(
        "opencode runs any model the openrouter gateway carries, named as the config names it, for example openrouter/x-ai/grok-4.6, openrouter/minimax/minimax-m3.",
      );
    });
  });

  describe("a config that names no gateway model", () => {
    const lines = runtimeLines(config({ orchestrator: { model: "mock" } }));

    it("gives no example", () => {
      expect(lines[3]).toBe(
        "opencode runs any model the openrouter gateway carries, named as the config names it.",
      );
    });
  });
});
