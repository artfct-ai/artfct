import { ClaudeCodeHarness } from "./claude-code/harness";
import { OpenCodeHarness } from "./opencode/harness";
import type { Harness, HarnessAdapter } from "./types";

/** The deployment secrets a harness adapter may take. Every one is optional. */
export type HarnessSecrets = {
  /** The Claude subscription token, the output of `claude setup-token`. */
  claudeOauthToken?: string | null;
};

/** The adapter for a harness name. The one place a harness adapter is constructed. */
export function harnessAdapter(name: Harness, secrets: HarnessSecrets = {}): HarnessAdapter {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeHarness({ oauthToken: secrets.claudeOauthToken ?? null });
    case "opencode":
      return new OpenCodeHarness();
    default: {
      const unreachable: never = name;
      throw new Error(`unknown harness ${String(unreachable)}`);
    }
  }
}
