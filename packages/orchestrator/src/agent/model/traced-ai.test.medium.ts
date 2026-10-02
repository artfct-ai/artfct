import * as ai from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { agentTelemetry, orchestratorIdentity } from "./agent-identity";
import { EchoModel } from "../../../test/fake-model";
import { tracedAI } from "./traced-ai";

describe("tracedAI", () => {
  it("is the wrapped namespace, not the plain one", () => {
    expect(tracedAI.generateText).not.toBe(ai.generateText);
  });

  describe("a call that carries the identity the way the model call site sends it", () => {
    let result: Awaited<ReturnType<typeof tracedAI.generateText>>;
    let contexts: unknown[];

    beforeEach(async () => {
      contexts = [];
      result = await tracedAI.generateText({
        model: new EchoModel("done"),
        system: "s",
        prompt: "go",
        onStepEnd: (step) => {
          contexts.push(step.runtimeContext);
        },
        ...agentTelemetry(orchestratorIdentity("wf_123"), "turn"),
      });
    });

    it("answers with the model's text", () => {
      expect(result.text).toBe("done");
    });

    it("gives every step the identity as its runtime context", () => {
      expect(contexts).toEqual([
        { agentId: "orchestrator", conversationId: "wf_123", operation: "turn" },
      ]);
    });
  });
});
