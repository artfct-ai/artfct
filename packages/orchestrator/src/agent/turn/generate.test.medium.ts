import { APICallError, type LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { tool, type ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EchoModel, ScriptedFailure } from "../../../test/fake-model";
import { generateSteps, MODEL_RETRIES, type GenerateOptions, type StepReport } from "./generate";
import { SupersededIsolateError } from "./superseded";

const tools = {
  ping: tool({ inputSchema: z.object({}), execute: async () => "pong" }),
};

const identity = { agentId: "test-agent", conversationId: "wf_test" };

function failingTool(error: Error) {
  return tool({
    inputSchema: z.object({}),
    execute: async (): Promise<string> => {
      throw error;
    },
  });
}

class RetryableOutage extends ScriptedFailure {
  attempts = 0;

  override doGenerate(): Promise<LanguageModelV4GenerateResult> {
    this.attempts += 1;
    return Promise.reject(
      new APICallError({
        message: "bad gateway",
        url: "https://gateway.test",
        requestBodyValues: {},
        statusCode: 502,
        isRetryable: true,
      }),
    );
  }
}

function request(patch: Partial<GenerateOptions>): GenerateOptions {
  return {
    model: new ScriptedFailure(["text"]),
    system: "s",
    messages: [{ role: "user", content: "go" }],
    tools,
    maxSteps: 5,
    identity,
    onStep: () => {},
    ...patch,
  };
}

describe("generateSteps", () => {
  describe("a tool call, then a model that fails", () => {
    let steps: StepReport[];
    let run: Promise<string>;
    beforeEach(async () => {
      steps = [];
      run = generateSteps(
        request({
          model: new ScriptedFailure(["call", "throw"]),
          onStep: (step) => {
            steps.push(step);
          },
        }),
      );
      await run.catch(() => undefined);
    });

    it("fails with the model outage", async () => {
      await expect(run).rejects.toThrow("model outage");
    });

    it("hands over the step that ran before it", () => {
      expect(steps).toHaveLength(1);
    });

    it("reports the tool call of that step", () => {
      expect(steps[0]!.toolCalls).toEqual([{ toolName: "ping", input: {} }]);
    });

    it("reports the messages of that step", () => {
      expect(steps[0]!.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    });

    it("reports no usage, since the fake model bills nothing", () => {
      expect(steps[0]!.usage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    });

    describe("and a second attempt that carries the step forward", () => {
      let text: string;
      beforeEach(async () => {
        const messages: ModelMessage[] = [{ role: "user", content: "go" }, ...steps[0]!.messages];
        text = await generateSteps(
          request({
            model: new ScriptedFailure(["text"]),
            messages,
            onStep: (step) => {
              steps.push(step);
            },
          }),
        );
      });

      it("continues to the model's text", () => {
        expect(text).toBe("done");
      });

      it("hands over its own step too", () => {
        expect(steps).toHaveLength(2);
      });

      it("reports no tool call on it", () => {
        expect(steps[1]!.toolCalls).toEqual([]);
      });
    });
  });

  describe("a retryable outage", () => {
    let model: RetryableOutage;
    let run: Promise<string>;
    beforeEach(async () => {
      model = new RetryableOutage([]);
      run = generateSteps(request({ model }));
      await run.catch(() => undefined);
    }, 15_000);

    it("fails with the error the gateway gave", async () => {
      await expect(run).rejects.toThrow("bad gateway");
    });

    it("tries once more and no more, so a turn cannot burn its deadline", () => {
      expect(MODEL_RETRIES).toBe(1);
      expect(model.attempts).toBe(1 + MODEL_RETRIES);
    });
  });

  describe("a tool that failed", () => {
    let steps: StepReport[];
    let text: string;
    beforeEach(async () => {
      steps = [];
      text = await generateSteps(
        request({
          model: new ScriptedFailure(["call", "text"]),
          tools: { ping: failingTool(new Error("linear: 400 Query too complex")) },
          onStep: (step) => {
            steps.push(step);
          },
        }),
      );
    });

    it("goes on to the model's text", () => {
      expect(text).toBe("done");
    });

    it("reports the failure with the step that called the tool", () => {
      expect(steps[0]!.toolErrors).toEqual([
        { toolName: "ping", error: "linear: 400 Query too complex" },
      ]);
    });

    it("reports no failure on the step after it", () => {
      expect(steps[1]!.toolErrors).toEqual([]);
    });
  });

  describe("a tool that found the isolate superseded", () => {
    let steps: StepReport[];
    let run: Promise<string>;
    beforeEach(async () => {
      steps = [];
      run = generateSteps(
        request({
          model: new ScriptedFailure(["call", "call", "text"]),
          tools: {
            ping: failingTool(new Error("Durable Object reset because its code was updated.")),
          },
          onStep: (step) => {
            steps.push(step);
          },
        }),
      );
      await run.catch(() => undefined);
    });

    it("fails as a superseded isolate", async () => {
      await expect(run).rejects.toThrow(SupersededIsolateError);
    });

    it("stops after the step that found it", () => {
      expect(steps).toHaveLength(1);
    });
  });

  describe("an onStep that finds the isolate superseded", () => {
    let calls: number;
    let run: Promise<string>;
    beforeEach(async () => {
      calls = 0;
      run = generateSteps(
        request({
          model: new ScriptedFailure(["call", "call", "text"]),
          onStep: () => {
            calls += 1;
            throw new Error("Durable Object reset because its code was updated.");
          },
        }),
      );
      await run.catch(() => undefined);
    });

    it("fails as a superseded isolate", async () => {
      await expect(run).rejects.toThrow(SupersededIsolateError);
    });

    it("stops after the first step", () => {
      expect(calls).toBe(1);
    });
  });

  describe("a request that names its active tools", () => {
    let model: EchoModel;
    beforeEach(async () => {
      model = new EchoModel("done");
      await generateSteps(
        request({ model, tools: { ...tools, pong: tools.ping }, activeTools: ["pong"] }),
      );
    });

    it("offers the model only those tools", () => {
      expect(model.toolNames).toEqual([["pong"]]);
    });
  });

  describe("a model that calls tools past the step budget", () => {
    let steps: StepReport[];
    let text: string;
    beforeEach(async () => {
      steps = [];
      text = await generateSteps(
        request({
          model: new ScriptedFailure(["call", "call", "call"]),
          maxSteps: 2,
          onStep: (step) => {
            steps.push(step);
          },
        }),
      );
    });

    it("offers the last step no tools, so the turn ends in text", () => {
      expect(text).toBe("done");
    });

    it("stops at the budget", () => {
      expect(steps.map((step) => step.toolCalls.length)).toEqual([1, 0]);
    });
  });

  describe("a call to a tool the request left out", () => {
    let steps: StepReport[];
    beforeEach(async () => {
      steps = [];
      await generateSteps(
        request({
          model: new ScriptedFailure(["call", "text"]),
          activeTools: [],
          onStep: (step) => {
            steps.push(step);
          },
        }),
      );
    });

    it("reports the call the model made", () => {
      expect(steps[0]!.toolCalls).toEqual([{ toolName: "ping", input: {} }]);
    });

    it("tells the model the tool is unavailable", () => {
      expect(steps[0]!.toolErrors[0]!.error).toContain("unavailable tool 'ping'");
    });
  });
});
