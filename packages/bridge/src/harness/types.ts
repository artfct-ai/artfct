import type { JsonRpcMessage } from "@artfct-ai/acp/jsonrpc";

/**
 * How to start one ACP-speaking harness: the command and the env only that process needs.
 */
export type HarnessSpec = { command: string[]; env: Record<string, string> };

/**
 * A running harness the bridge can write to. Messages from the harness
 * reach the bridge through a callback given when the harness starts.
 */
export type HarnessTransport = {
  /** Deliver one message from the server to the harness. */
  send(message: JsonRpcMessage): void;
  /** Stop the harness. A no-op for in-process harnesses. */
  kill(): void;
};
