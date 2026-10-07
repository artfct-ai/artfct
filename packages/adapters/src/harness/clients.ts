import { ClaudeCodeHarness, type ClaudeCredential } from "./claude-code/harness";
import { OpenCodeHarness } from "./opencode/harness";
import type { Harness, HarnessAdapter } from "./types";

/** The deployment secrets a harness adapter may take. Every one is optional. */
export type HarnessSecrets = {
  /** The Claude subscription token, the output of `claude setup-token`. */
  claudeOauthToken?: string | null;
  /** A Claude Platform API key. The subscription token wins when both are set. */
  anthropicApiKey?: string | null;
};

/** The adapter for a harness name. The one place a harness adapter is constructed. */
export function harnessAdapter(name: Harness, secrets: HarnessSecrets = {}): HarnessAdapter {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeHarness({ credential: claudeCredential(secrets) });
    case "opencode":
      return new OpenCodeHarness();
    default: {
      const unreachable: never = name;
      throw new Error(`unknown harness ${String(unreachable)}`);
    }
  }
}

function claudeCredential(secrets: HarnessSecrets): ClaudeCredential | null {
  if (secrets.claudeOauthToken) return { kind: "oauth_token", token: secrets.claudeOauthToken };
  if (secrets.anthropicApiKey) return { kind: "api_key", key: secrets.anthropicApiKey };
  return null;
}
