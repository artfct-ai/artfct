import { beforeEach, describe, expect, it } from "bun:test";
import { compatEffort, OpenCodeHarness, opencodeConfig } from "./harness";
import type { HarnessTaskInput } from "../types";

const compat = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "x-ai/grok-4.6",
  apiKey: "t",
  headers: { "x-title": "ao" },
  fields: {},
  catalog: { provider: "openrouter", model: "x-ai/grok-4.6" },
};

const throughGateway = {
  ...compat,
  baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
  model: "openrouter/x-ai/grok-4.6",
  catalog: { provider: "gateway", model: "openrouter/x-ai/grok-4.6" },
};

const uncatalogued = {
  ...compat,
  model: "acme/house-model",
  catalog: { provider: "gateway", model: "acme/house-model" },
};

const input: HarnessTaskInput = {
  model: "openrouter/x-ai/grok-4.6",
  effort: "xhigh",
  repoFull: "acme/app",
  gateway: { anthropic: null, compat },
};

const harness = new OpenCodeHarness();

type ParsedModel = {
  id: string;
  options?: { reasoningEffort: string };
  cost?: { input: number; output: number; cache_read: number };
  limit?: { context: number; output: number };
};

type ParsedConfig = {
  model: string;
  provider: Record<string, { options: unknown; models: Record<string, ParsedModel> }>;
};

function requireSetup(task: HarnessTaskInput) {
  const setup = harness.setup(task);
  if ("error" in setup) throw new Error(setup.error);
  return setup;
}

describe("OpenCodeHarness", () => {
  it("spawns the native ACP command", () => {
    expect(harness.command()).toEqual({ command: ["opencode", "acp"], env: {} });
  });

  it("reads its instructions from the global AGENTS.md in its config directory", () => {
    expect(harness.instructionsFile).toBe("/home/node/.config/opencode/AGENTS.md");
  });

  it("names a skill to its skill tool by id", () => {
    expect(harness.invokeSkill("design")).toBe(
      'Call the skill tool with id "design" first. Then follow the skill it returns for this task.',
    );
  });

  it("refuses no model", () => {
    expect(harness.modelRefusal()).toBeNull();
  });

  describe("a task with a gateway route", () => {
    let setup: ReturnType<typeof requireSetup>;

    beforeEach(() => {
      setup = requireSetup(input);
    });

    it("sets no env", () => {
      expect(setup.env).toEqual({});
    });

    it("writes its config file and its plugins", () => {
      expect(setup.files.map((file) => file.path)).toEqual([
        "/home/node/.config/opencode/opencode.json",
        "/home/node/.config/opencode/plugins/rtk.js",
        "/home/node/.config/opencode/plugins/todo.js",
      ]);
    });

    it("keeps the coding prompt and the repository instruction files", () => {
      expect(setup.env).toEqual({});
      expect(JSON.parse(setup.files[0]!.content)).not.toHaveProperty("agent");
    });

    it("runs no setup command", () => {
      expect(setup.commands).toEqual([]);
    });

    it("names the routed model in the config", () => {
      expect(JSON.parse(setup.files[0]!.content)).toMatchObject({
        model: "openrouter/x-ai/grok-4.6",
      });
    });
  });

  describe("a task with no gateway", () => {
    it("refuses to run", () => {
      const setup = harness.setup({ ...input, gateway: null });
      expect("error" in setup ? setup.error : "").toMatch(/needs a gateway/);
    });
  });

  describe("the todo list", () => {
    it("comes from a todowrite tool call", () => {
      const todos = [{ content: "Write the fix", status: "in_progress", priority: "high" }];
      expect(
        harness.plan({
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          title: "todowrite",
          status: "in_progress",
          rawInput: { todos },
        }),
      ).toEqual([{ content: "Write the fix", status: "in_progress", priority: "high" }]);
    });

    it("comes from a plan update alike", () => {
      const entries = [{ content: "Read", status: "pending" as const, priority: "low" as const }];
      expect(harness.plan({ sessionUpdate: "plan", entries })).toEqual(entries);
    });

    it("ignores every other tool call", () => {
      expect(
        harness.plan({
          sessionUpdate: "tool_call",
          toolCallId: "c2",
          title: "bash",
          kind: "execute",
        }),
      ).toBeNull();
    });
  });

  describe("the models line in the prompt", () => {
    it("names the gateway and the config's models", () => {
      expect(
        harness.modelsLine({ gateway: "openrouter", examples: ["openrouter/a", "openrouter/b"] }),
      ).toBe(
        "opencode runs any model the openrouter gateway carries, named as the config names it, for example openrouter/a, openrouter/b.",
      );
    });

    it("drops the examples when the gateway offers none", () => {
      expect(harness.modelsLine({ gateway: "cloudflare", examples: [] })).toBe(
        "opencode runs any model the cloudflare gateway carries, named as the config names it.",
      );
    });
  });
});

describe("opencodeConfig", () => {
  describe("no configured effort", () => {
    const config = JSON.parse(opencodeConfig(uncatalogued, null)) as ParsedConfig;

    it("sends no reasoningEffort, so OpenCode keeps its own default", () => {
      expect(config.provider["gateway"]?.models).toEqual({
        "acme/house-model": { id: "acme/house-model" },
      });
    });
  });

  describe("a route whose catalog no registry prices", () => {
    const config = JSON.parse(opencodeConfig(uncatalogued, "medium")) as ParsedConfig;

    it("declares the model under the provider the route named", () => {
      expect(config.model).toBe("gateway/acme/house-model");
    });

    it("keys the model by its wire name and carries the effort", () => {
      expect(config.provider["gateway"]?.models).toEqual({
        "acme/house-model": { id: "acme/house-model", options: { reasoningEffort: "medium" } },
      });
    });

    it("points the provider at the route with its key and headers", () => {
      expect(config.provider["gateway"]?.options).toEqual({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "t",
        headers: compat.headers,
      });
    });
  });

  describe("a route that names a catalog", () => {
    const config = JSON.parse(opencodeConfig(compat, "high")) as ParsedConfig;

    it("declares the model under that catalog, which is what OpenCode prices from", () => {
      expect(config.model).toBe("openrouter/x-ai/grok-4.6");
    });

    it("keys the model by the name the catalog knows it as", () => {
      expect(config.provider["openrouter"]?.models).toEqual({
        "x-ai/grok-4.6": { id: "x-ai/grok-4.6", options: { reasoningEffort: "high" } },
      });
    });

    it("declares no price of its own, so nothing here can go stale", () => {
      const declared = config.provider["openrouter"]?.models["x-ai/grok-4.6"];
      expect(declared?.cost).toBeUndefined();
      expect(declared?.limit).toBeUndefined();
    });

    it("takes the provider name from the route, naming no gateway vendor itself", () => {
      expect(Object.keys(config.provider)).toEqual([compat.catalog.provider]);
    });
  });

  describe("a catalogued model whose wire name differs from its catalog name", () => {
    const prefixed = { ...compat, model: "openrouter/x-ai/grok-4.6" };
    const config = JSON.parse(opencodeConfig(prefixed, "high")) as ParsedConfig;

    it("keys it by the catalog name and sends the wire name as the id", () => {
      expect(config.provider["openrouter"]?.models).toEqual({
        "x-ai/grok-4.6": {
          id: "openrouter/x-ai/grok-4.6",
          options: { reasoningEffort: "high" },
        },
      });
    });
  });

  describe("the same model through the Cloudflare gateway", () => {
    const config = JSON.parse(opencodeConfig(throughGateway, "high")) as ParsedConfig;

    it("uses the unpriced provider the gateway named, so cost stays unknown on that route", () => {
      expect(config.model).toBe("gateway/openrouter/x-ai/grok-4.6");
      expect(config.provider["openrouter"]).toBeUndefined();
    });

    it("still routes, keying the model by the wire name that gateway needs", () => {
      expect(config.provider["gateway"]?.models).toEqual({
        "openrouter/x-ai/grok-4.6": {
          id: "openrouter/x-ai/grok-4.6",
          options: { reasoningEffort: "high" },
        },
      });
    });
  });
});

describe("compatEffort", () => {
  it("sends a level the API knows as it is", () => {
    expect(compatEffort("low")).toBe("low");
  });

  it("sends xhigh as high", () => {
    expect(compatEffort("xhigh")).toBe("high");
  });

  it("sends max as high", () => {
    expect(compatEffort("max")).toBe("high");
  });
});
