import type { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";

type AgentMethod = (typeof AGENT_METHODS)[keyof typeof AGENT_METHODS];
type ClientMethod = (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];

/** ACP methods the orchestrator sends to the agent. Values are checked against the SDK. */
export const AgentMethods = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionSetConfigOption: "session/set_config_option",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
} as const satisfies Record<string, AgentMethod>;

/** ACP methods the agent sends to the orchestrator. */
export const ClientMethods = {
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
} as const satisfies Record<string, ClientMethod>;

/** Control-plane methods between the sandbox bridge and the orchestrator. Not part of ACP. */
export const BridgeMethods = {
  hello: "bridge/hello",
  exit: "bridge/exit",
  restart: "bridge/restart",
  log: "bridge/log",
} as const;

/** What the bridge reports about itself on every connect. */
export type BridgeHelloParams = { fresh: boolean; harness: string; generation: number };

/** How the harness process ended. */
export type BridgeExitParams = { code: number | null; signal: string | null };

/** One line of bridge output for the workflow log. */
export type BridgeLogParams = { text: string };
