import { describe, expect, it } from "bun:test";
import { harnessAdapter } from "./clients";
import { HARNESSES, type HarnessTaskInput } from "./types";

describe("harnessAdapter", () => {
  it("gives every harness an adapter that reports its own name", () => {
    for (const name of HARNESSES) expect(harnessAdapter(name).name).toBe(name);
  });

  describe("a configured Claude subscription token", () => {
    const task: HarnessTaskInput = {
      model: "claude-sonnet-5",
      effort: "xhigh",
      repoFull: null,
      gateway: null,
    };

    it("reaches Claude Code in env", () => {
      const claude = harnessAdapter("claude-code", { claudeOauthToken: "sk-ant-oat" }).setup(task);
      expect("env" in claude ? claude.env.CLAUDE_CODE_OAUTH_TOKEN : null).toBe("sk-ant-oat");
    });

    it("reaches no other harness", () => {
      const opencode = harnessAdapter("opencode", { claudeOauthToken: "sk-ant-oat" }).setup(task);
      expect(JSON.stringify(opencode)).not.toContain("sk-ant-oat");
    });

    it("wins over a configured API key", () => {
      const claude = harnessAdapter("claude-code", {
        claudeOauthToken: "sk-ant-oat",
        anthropicApiKey: "sk-ant-api",
      }).setup(task);
      expect("env" in claude ? claude.env : null).toMatchObject({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat",
      });
      expect(JSON.stringify(claude)).not.toContain("sk-ant-api");
    });
  });

  describe("a configured Anthropic API key", () => {
    const task: HarnessTaskInput = {
      model: "claude-sonnet-5",
      effort: "xhigh",
      repoFull: null,
      gateway: null,
    };

    it("reaches Claude Code in env", () => {
      const claude = harnessAdapter("claude-code", { anthropicApiKey: "sk-ant-api" }).setup(task);
      expect("env" in claude ? claude.env.ANTHROPIC_API_KEY : null).toBe("sk-ant-api");
    });

    it("reaches no other harness", () => {
      const opencode = harnessAdapter("opencode", { anthropicApiKey: "sk-ant-api" }).setup(task);
      expect(JSON.stringify(opencode)).not.toContain("sk-ant-api");
    });
  });
});
