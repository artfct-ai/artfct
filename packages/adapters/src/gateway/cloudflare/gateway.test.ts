import { describe, expect, it } from "bun:test";
import { CloudflareGateway } from "./gateway";

const config = { accountId: "acct", gatewayId: "gw", token: "t", openRouterKey: "sk-or" };
const metadata = { workflow_id: "wf_1", stage: "orchestrator" };
const BASE = "https://gateway.ai.cloudflare.com/v1/acct/gw";

describe("CloudflareGateway", () => {
  describe("compatRoute", () => {
    describe("a model the gateway bills", () => {
      const route = new CloudflareGateway(config).compatRoute("workers-ai/@cf/model", metadata);

      it("sends the gateway headers and no Authorization", () => {
        expect(route).toEqual({
          baseUrl: `${BASE}/compat`,
          model: "workers-ai/@cf/model",
          apiKey: "t",
          headers: {
            "cf-aig-authorization": "Bearer t",
            "cf-aig-metadata": JSON.stringify(metadata),
          },
          fields: {},
          catalog: { provider: "gateway", model: "workers-ai/@cf/model" },
        });
      });
    });

    describe("an OpenRouter model", () => {
      const route = new CloudflareGateway(config).compatRoute("openrouter/x-ai/grok-4.6", metadata);

      it("passes the model name through", () => {
        expect(route.model).toBe("openrouter/x-ai/grok-4.6");
      });

      it("bills the OpenRouter key", () => {
        expect(route.apiKey).toBe("sk-or");
      });

      it("carries both the OpenRouter and the gateway authorization", () => {
        expect(route.headers).toMatchObject({
          Authorization: "Bearer sk-or",
          "cf-aig-authorization": "Bearer t",
        });
      });

      it("asks for the cost", () => {
        expect(route.fields).toEqual({ usage: { include: true } });
      });

      it("names the unpriced catalog, because the prefix it keeps on the wire is in none", () => {
        expect(route.catalog).toEqual({
          provider: "gateway",
          model: "openrouter/x-ai/grok-4.6",
        });
      });
    });

    describe("an OpenRouter model with no OpenRouter key configured", () => {
      const gateway = new CloudflareGateway({ ...config, openRouterKey: undefined });

      it("refuses the model", () => {
        expect(() => gateway.compatRoute("openrouter/x-ai/grok-4.6", metadata)).toThrow(
          /OpenRouter key/,
        );
      });
    });
  });

  describe("a deployment that keeps OpenRouter requests in a region", () => {
    const gateway = new CloudflareGateway({ ...config, openRouterRegion: "eu" });

    it("refuses an OpenRouter model, because the passthrough leaves the region", () => {
      expect(() => gateway.compatRoute("openrouter/x-ai/grok-4.6", metadata)).toThrow(
        "model openrouter/x-ai/grok-4.6 passes through to OpenRouter's global host, which is outside the eu region. Route it through the OpenRouter gateway.",
      );
    });

    it("routes every other model as before", () => {
      expect(gateway.compatRoute("workers-ai/@cf/meta/llama", metadata).model).toBe(
        "workers-ai/@cf/meta/llama",
      );
    });
  });

  describe("decisions", () => {
    it("carries the Clef decisions model", () => {
      expect(new CloudflareGateway(config).decisions().model).toBe("@cf/cloudflare/clef");
    });
  });

  describe("anthropicRoute", () => {
    const tagged = { workflow_id: "wf_1", task_id: "wf_1.1", stage: "implement" };

    it("points Claude Code at the anthropic endpoint with the task metadata", () => {
      expect(new CloudflareGateway(config).anthropicRoute(tagged)).toEqual({
        baseUrl: `${BASE}/anthropic`,
        headers: {
          "cf-aig-authorization": "Bearer t",
          "cf-aig-metadata": JSON.stringify(tagged),
        },
      });
    });
  });
});
