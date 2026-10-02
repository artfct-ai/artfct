import type { Gateway } from "@artfct-ai/adapters/gateway/types";
import { FAKE_METADATA_HEADER, FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { loadConfig } from "../../config/config";
import type { GatewayProvider } from "../../config/gateway";
import { generateText } from "ai";
import { beforeEach, describe, expect, it } from "bun:test";
import { testEnv } from "../../../test/test-env";
import { initialWorkflowState } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";
import { orchestratorModel, timedFetch } from "./model";

const env = testEnv();

const BASE = "https://gateway.ai.cloudflare.com/v1/acc/gw";

function runtime(
  orchestrator: string,
  gateway: Gateway | null,
  requests: GatewayProvider[] = [],
): WorkflowRuntime {
  const config = loadConfig(`orchestrator: ${orchestrator}`);
  const slice: Pick<WorkflowRuntime, "env" | "state" | "config" | "gateway"> = {
    env,
    state: { ...initialWorkflowState, workflow_id: "wf_model" },
    config: () => config,
    gateway: (provider) => {
      requests.push(provider);
      return gateway;
    },
  };
  return slice as WorkflowRuntime;
}

const gateway = new FakeGateway({ baseUrl: BASE, fields: { usage: { include: true } } });

type Recorded = { url: string; headers: Record<string, string>; body: unknown };

function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchBody(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "";
}

function fakeFetch(requests: Recorded[]): typeof fetch {
  return async (input, init) => {
    requests.push({
      url: fetchUrl(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(fetchBody(init)),
    });
    return Response.json({
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: "dynamic/orchestrator",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.002 },
    });
  };
}

function signalFetch(signals: (AbortSignal | undefined)[]): typeof fetch {
  return async (_input, init) => {
    signals.push(init?.signal ?? undefined);
    return new Response("ok");
  };
}

describe("timedFetch", () => {
  describe("a request under a short timeout", () => {
    let signals: (AbortSignal | undefined)[];

    beforeEach(async () => {
      signals = [];
      await timedFetch(signalFetch(signals), 10)("https://gateway.test");
    });

    it("leaves the signal open while the request runs", () => {
      expect(signals[0]?.aborted).toBe(false);
    });

    describe("once the timeout passes", () => {
      beforeEach(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      it("aborts the request", () => {
        expect(signals[0]?.aborted).toBe(true);
      });

      it("names the timeout as the reason", () => {
        const reason = signals[0]?.reason as { name?: string } | undefined;
        expect(reason?.name).toBe("TimeoutError");
      });
    });
  });

  describe("a caller that brought its own signal", () => {
    let signals: (AbortSignal | undefined)[];
    let controller: AbortController;

    beforeEach(async () => {
      signals = [];
      controller = new AbortController();
      await timedFetch(signalFetch(signals), 10_000)("https://gateway.test", {
        signal: controller.signal,
      });
    });

    it("leaves the signal open while the request runs", () => {
      expect(signals[0]?.aborted).toBe(false);
    });

    describe("once the caller aborts", () => {
      beforeEach(() => {
        controller.abort(new Error("turn over"));
      });

      it("aborts the request too", () => {
        expect(signals[0]?.aborted).toBe(true);
      });
    });
  });

  describe("a gateway request the orchestrator model made", () => {
    let signals: (AbortSignal | undefined)[];

    beforeEach(async () => {
      signals = [];
      const model = orchestratorModel(
        runtime("{ model: dynamic/orchestrator }", gateway),
        undefined,
        {
          fetch: async (input, init) => {
            signals.push(init?.signal ?? undefined);
            return fakeFetch([])(input, init);
          },
        },
      );
      await generateText({ model, prompt: "hello" });
    });

    it("carries the configured deadline as a signal", () => {
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    });

    it("leaves that signal open while the request runs", () => {
      expect(signals[0]?.aborted).toBe(false);
    });
  });
});

describe("orchestratorModel", () => {
  describe("a model whose gateway has no secrets", () => {
    it("refuses the Cloudflare gateway and names its secrets", () => {
      expect(() => orchestratorModel(runtime("{ model: dynamic/orchestrator }", null))).toThrow(
        /CF_ACCOUNT_ID, AI_GATEWAY_ID, and AI_GATEWAY_TOKEN/,
      );
    });

    it("refuses another gateway and names its key", () => {
      const direct = runtime("{ model: openrouter/x-ai/grok-4.6, gateway: openrouter }", null);
      expect(() => orchestratorModel(direct)).toThrow(/OPEN_ROUTER_API_KEY/);
    });
  });

  describe("a request through the gateway", () => {
    let requests: Recorded[];
    let result: Awaited<ReturnType<typeof generateText>>;

    beforeEach(async () => {
      requests = [];
      const workflow = runtime("{ model: dynamic/orchestrator }", gateway);
      const model = orchestratorModel(workflow, undefined, { fetch: fakeFetch(requests) });
      result = await generateText({ model, prompt: "hello" });
    });

    it("answers with the model's text", () => {
      expect(result.text).toBe("hi");
    });

    it("reports the cost the provider sent", () => {
      expect(result.steps[0]?.usage.raw).toMatchObject({ cost: 0.002 });
    });

    it("sends one request, on the route the gateway gave it", () => {
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`${BASE}/compat/chat/completions`);
    });

    it("carries the gateway's own headers", () => {
      expect(requests[0]!.headers["x-fake-gateway"]).toBe("yes");
    });

    it("names the workflow and the stage in the metadata header", () => {
      expect(JSON.parse(requests[0]!.headers[FAKE_METADATA_HEADER]!)).toEqual({
        workflow_id: "wf_model",
        stage: "orchestrator",
      });
    });

    it("puts the gateway's own fields on the body beside the model", () => {
      expect(requests[0]!.body).toMatchObject({
        model: "dynamic/orchestrator",
        usage: { include: true },
      });
    });
  });

  describe("the orchestrator's own model and a prompt's model", () => {
    let asked: GatewayProvider[];

    beforeEach(() => {
      asked = [];
      const workflow = runtime(
        "{ model: dynamic/orchestrator, gateway: cloudflare }",
        gateway,
        asked,
      );
      orchestratorModel(workflow);
      orchestratorModel(workflow, "openrouter/minimax/minimax-m3", { gateway: "openrouter" });
    });

    it("asks the orchestrator's gateway first and the prompt's second", () => {
      expect(asked).toEqual(["cloudflare", "openrouter"]);
    });

    it("asks the prompt's gateway for the prompt's model", () => {
      expect(gateway.calls.at(-1)?.args[0]).toBe("openrouter/minimax/minimax-m3");
    });
  });

  describe("a named prompt with its own model", () => {
    let requests: Recorded[];

    beforeEach(async () => {
      requests = [];
      const workflow = runtime("{ model: dynamic/orchestrator }", gateway);
      const model = orchestratorModel(workflow, "google-ai-studio/gemini-2.5-flash", {
        fetch: fakeFetch(requests),
      });
      await generateText({ model, prompt: "hello" });
    });

    it("sends the prompt's model instead of the orchestrator's own", () => {
      expect(requests[0]!.body).toMatchObject({ model: "google-ai-studio/gemini-2.5-flash" });
    });

    it("sends it on the route the gateway gave it", () => {
      expect(requests[0]!.url).toBe(`${BASE}/compat/chat/completions`);
    });
  });

  describe("model_params on the orchestrator's own model", () => {
    it("puts them on every request", async () => {
      const requests: Recorded[] = [];
      const orchestrator =
        "{ model: dynamic/orchestrator, model_params: { reasoning_effort: none } }";
      const model = orchestratorModel(runtime(orchestrator, gateway), undefined, {
        fetch: fakeFetch(requests),
      });
      await generateText({ model, prompt: "hello" });
      expect(requests[0]!.body).toMatchObject({
        model: "dynamic/orchestrator",
        reasoning_effort: "none",
      });
    });
  });

  describe("a model_param the provider does not know", () => {
    it("sends the field as it is", async () => {
      const requests: Recorded[] = [];
      const orchestrator =
        "{ model: dynamic/orchestrator, model_params: { chat_template_kwargs: { enable_thinking: false } } }";
      const model = orchestratorModel(runtime(orchestrator, gateway), undefined, {
        fetch: fakeFetch(requests),
      });
      await generateText({ model, prompt: "hello" });
      expect(requests[0]!.body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    });
  });

  describe("a prompt that brought its own params", () => {
    const params = { chat_template_kwargs: { enable_thinking: false } };
    let requests: Recorded[];

    beforeEach(async () => {
      requests = [];
      const orchestrator =
        "{ model: dynamic/orchestrator, model_params: { reasoning_effort: none } }";
      const model = orchestratorModel(runtime(orchestrator, gateway), "workers-ai/flash", {
        fetch: fakeFetch(requests),
        params,
      });
      await generateText({ model, prompt: "hi" });
    });

    it("puts the prompt's params on the request", () => {
      expect(requests[0]!.body).toMatchObject(params);
    });

    it("leaves the orchestrator's own params off", () => {
      expect(requests[0]!.body).not.toHaveProperty("reasoning_effort");
    });
  });
});
