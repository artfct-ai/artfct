import { describe, expect, it } from "bun:test";
import { agentTelemetry, orchestratorIdentity } from "./agent-identity";

describe("orchestratorIdentity", () => {
  it("ties the orchestrator's agent id to the workflow as its conversation id", () => {
    expect(orchestratorIdentity("wf_123")).toEqual({
      agentId: "orchestrator",
      conversationId: "wf_123",
    });
  });
});

describe("agentTelemetry", () => {
  const identity = orchestratorIdentity("wf_123");

  describe("a named prompt", () => {
    it("keeps one agent name and marks the operation in the runtime context", () => {
      expect(agentTelemetry(identity, "prompt:compact")).toEqual({
        runtimeContext: {
          agentId: "orchestrator",
          conversationId: "wf_123",
          operation: "prompt:compact",
        },
        telemetry: {
          functionId: "orchestrator",
          includeRuntimeContext: { agentId: true, conversationId: true, operation: true },
        },
      });
    });
  });

  describe("a turn", () => {
    it("uses the same agent name as a named prompt", () => {
      expect(agentTelemetry(identity, "turn").telemetry.functionId).toBe(
        agentTelemetry(identity, "prompt:compact").telemetry.functionId,
      );
    });
  });
});
