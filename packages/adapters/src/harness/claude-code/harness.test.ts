import { describe, expect, it } from "bun:test";
import { ClaudeCodeHarness } from "./harness";
import type { HarnessTaskInput } from "../types";

const compat = {
  baseUrl: "https://gw/compat",
  model: "claude-sonnet-5",
  apiKey: "t",
  headers: { "cf-aig-authorization": "Bearer t" },
  fields: {},
  catalog: { provider: "anthropic", model: "claude-sonnet-5" },
};

const anthropic = {
  baseUrl: "https://gw/anthropic",
  headers: { "cf-aig-authorization": "Bearer t", "cf-aig-metadata": '{"task_id":"wf_x.1"}' },
};

const input: HarnessTaskInput = {
  model: "claude-sonnet-5",
  effort: "xhigh",
  repoFull: "acme/app",
  gateway: { anthropic, compat },
};

const settings = { path: "/home/node/.claude/settings.json", content: '{"effortLevel":"xhigh"}' };

const RTK_HOOK_INSTALL = "rtk init --global --hook-only --auto-patch";

const withToken = new ClaudeCodeHarness({ oauthToken: "sk-ant-oat" });
const withoutToken = new ClaudeCodeHarness({ oauthToken: null });

describe("ClaudeCodeHarness", () => {
  describe("the todo list", () => {
    it("comes from ACP plan updates", () => {
      const entries = [{ content: "Read", status: "pending" as const, priority: "low" as const }];
      expect(withoutToken.plan({ sessionUpdate: "plan", entries })).toEqual(entries);
    });

    it("turns on the todo tools Claude Code withholds from newer models", () => {
      const built = withToken.setup({ ...input, model: "claude-opus-5-5" });
      expect("env" in built ? built.env.CLAUDE_CODE_ENABLE_TODO_TOOLS : null).toBe("1");
    });

    it("ignores the TodoWrite tool call", () => {
      expect(
        withoutToken.plan({
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "TodoWrite",
          rawInput: { todos: [{ content: "x", status: "pending", priority: "low" }] },
        }),
      ).toBeNull();
    });
  });

  describe("the spawned command", () => {
    it("runs the official ACP adapter with the model in its env", () => {
      expect(withoutToken.command("claude-x")).toEqual({
        command: ["claude-agent-acp"],
        env: { ANTHROPIC_MODEL: "claude-x" },
      });
    });

    it("names no model when the task picks none", () => {
      expect(withoutToken.command(undefined).env).toEqual({});
    });
  });

  it("reads its instructions from the home-level CLAUDE.md", () => {
    expect(withoutToken.instructionsFile).toBe("/home/node/.claude/CLAUDE.md");
  });

  describe("a configured subscription token", () => {
    it("goes in env and skips the gateway", () => {
      expect(withToken.setup(input)).toEqual({
        env: {
          ANTHROPIC_MODEL: "claude-sonnet-5",
          CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat",
        },
        files: [settings],
        commands: [RTK_HOOK_INSTALL],
      });
    });

    it("writes the effort into the settings file Claude Code reads", () => {
      const built = withToken.setup({ ...input, effort: "max" });
      expect("files" in built ? built.files : []).toEqual([
        { path: "/home/node/.claude/settings.json", content: '{"effortLevel":"max"}' },
      ]);
    });

    it("writes no settings file when no effort is configured", () => {
      const built = withToken.setup({ ...input, effort: null });
      expect("files" in built ? built.files : null).toEqual([]);
    });
  });

  describe("no subscription token", () => {
    it("routes through the gateway with its headers, one per line", () => {
      expect(withoutToken.setup(input)).toEqual({
        env: {
          ANTHROPIC_MODEL: "claude-sonnet-5",
          CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
          ANTHROPIC_BASE_URL: "https://gw/anthropic",
          ANTHROPIC_CUSTOM_HEADERS:
            'cf-aig-authorization: Bearer t\ncf-aig-metadata: {"task_id":"wf_x.1"}',
        },
        files: [settings],
        commands: [RTK_HOOK_INSTALL],
      });
    });

    it("refuses a gateway that carries no Anthropic route", () => {
      const noRoute = withoutToken.setup({ ...input, gateway: { anthropic: null, compat } });
      expect("error" in noRoute ? noRoute.error : "").toMatch(/no Anthropic endpoint/);
    });

    it("refuses a task with no gateway at all", () => {
      const noGateway = withoutToken.setup({ ...input, gateway: null });
      expect("error" in noGateway ? noGateway.error : "").toMatch(/No gateway is configured/);
    });
  });

  describe("the model name", () => {
    it("refuses a gateway model", () => {
      expect(withoutToken.modelRefusal("openrouter/x-ai/grok-4.6")).toBe(
        "claude-code runs Anthropic models by their plain id. openrouter/x-ai/grok-4.6 is a gateway model: run it on opencode, or pick an Anthropic id for claude-code.",
      );
    });

    it("lets a plain Anthropic id through", () => {
      expect(withoutToken.modelRefusal("claude-sonnet-5")).toBeNull();
    });
  });

  describe("the model list", () => {
    it("lists Anthropic's models as the anthropic vendor's", async () => {
      const catalog = {
        anthropic: {
          models: {
            "claude-sonnet-5": {
              id: "claude-sonnet-5",
              name: "Claude Sonnet 5",
              release_date: "2026-06-29",
            },
          },
        },
      };
      const harness = new ClaudeCodeHarness({
        oauthToken: null,
        fetch: async () => Response.json(catalog),
      });

      expect(await harness.models()).toEqual({
        vendor: "anthropic",
        models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", released: "2026-06-29" }],
      });
    });
  });
});
