import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { HarnessRequest, HarnessSteering } from "../types";

/** The ACP extension method of the Claude Code adapter that adds a message to the running turn. */
export const CLAUDE_CODE_STEERING_METHOD = "_session/steering";

/** The params of a steering request to the Claude Code adapter. */
type ClaudeCodeSteeringParams = {
  sessionId: string;
  prompt: ContentBlock[];
  _meta: { steering: { idleBehavior: "promptRequired" } };
};

/** The Claude Code adapter's answer to a steering request. */
type ClaudeCodeSteeringResult =
  | { outcome: "injected" }
  | { outcome: "promptRequired"; reason: string };

/**
 * Steering through the Claude Code adapter. A session without a running turn answers that it needs
 * a prompt, so a steer never starts a turn of its own.
 */
export class ClaudeCodeSteering implements HarnessSteering {
  request(sessionId: string, text: string): HarnessRequest {
    const params: ClaudeCodeSteeringParams = {
      sessionId,
      prompt: [{ type: "text", text }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    };
    return { method: CLAUDE_CODE_STEERING_METHOD, params };
  }

  taken(result: unknown): boolean {
    return (result as Partial<ClaudeCodeSteeringResult> | null)?.outcome === "injected";
  }
}
