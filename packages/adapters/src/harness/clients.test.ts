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
  });
});
