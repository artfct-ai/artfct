/** Identity attached to a traced model call so the Cloudflare Agents dashboard groups it correctly. */
export type AgentIdentity = {
  agentId: string;
  conversationId: string;
};

/** What a traced call does inside a workflow, for example `prompt:summarize`. */
export type AgentOperation = "turn" | `prompt:${string}`;

const AGENT_ID = "orchestrator";

/** The orchestrator's identity for one workflow. Every traced call for it shares this. */
export function orchestratorIdentity(workflowId: string): AgentIdentity {
  return { agentId: AGENT_ID, conversationId: workflowId };
}

/** Telemetry fields for one traced call. */
export function agentTelemetry(identity: AgentIdentity, operation: AgentOperation) {
  return {
    runtimeContext: { ...identity, operation },
    telemetry: {
      functionId: AGENT_ID,
      includeRuntimeContext: { agentId: true, conversationId: true, operation: true },
    },
  } as const;
}
