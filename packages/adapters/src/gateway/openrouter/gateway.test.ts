import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { OpenRouterGateway, openRouterModel } from "./gateway";
import type { Gateway } from "../types";

const metadata = { workflow_id: "wf_1", stage: "orchestrator" };

describe("OpenRouterGateway", () => {
  const gateway: Gateway = new OpenRouterGateway({ apiKey: "sk-or" });

  describe("compatRoute", () => {
    it("drops the openrouter prefix and carries the key and the usage request", () => {
      expect(gateway.compatRoute("openrouter/x-ai/grok-4.6", metadata)).toEqual({
        baseUrl: "https://openrouter.ai/api/v1",
        model: "x-ai/grok-4.6",
        apiKey: "sk-or",
        headers: { Authorization: "Bearer sk-or" },
        fields: { usage: { include: true } },
        catalog: { provider: "openrouter", model: "x-ai/grok-4.6" },
      });
    });

    it("names the catalog a harness prices from, by the name that catalog knows", () => {
      expect(gateway.compatRoute("openrouter/minimax/minimax-m3", metadata).catalog).toEqual({
        provider: "openrouter",
        model: "minimax/minimax-m3",
      });
    });
  });

  describe("compatRoute in a region", () => {
    const regional: Gateway = new OpenRouterGateway({ apiKey: "sk-or", region: "eu" });

    it("sends the request to the host of the region", () => {
      expect(regional.compatRoute("openrouter/z-ai/glm-5.3", metadata).baseUrl).toBe(
        "https://eu.openrouter.ai/api/v1",
      );
    });
  });

  describe("anthropicRoute", () => {
    it("has none", () => {
      expect(gateway.anthropicRoute(metadata)).toBeNull();
    });
  });

  describe("decisions", () => {
    const ASKED = {
      yesNo: { done: { instructions: "Is `message` done?", yes: "Done.", no: "Not done." } },
      choices: {},
    };

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

    async function modelsSent(models: readonly [string, ...string[]]): Promise<string[]> {
      const sent: string[] = [];
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const { model } = JSON.parse(await new Request(input, init).text());
        sent.push(model);
        return Response.json({
          model,
          answers: { done: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        });
      });
      await gateway.decisions(models).decide({ message: "done" }, ASKED);
      return sent;
    }

    it("asks the decisions model the config names, as OpenRouter knows it", async () => {
      expect(await modelsSent(["openrouter/typesafe/jev-1.13"])).toEqual(["typesafe/jev-1.13"]);
    });

    it("asks each model of the list by its OpenRouter name", async () => {
      expect(
        await modelsSent(["openrouter/typesafe/jev-1.13", "openrouter/cloudflare/clef"]),
      ).toEqual(["typesafe/jev-1.13"]);
    });
  });
});

describe("openRouterModel", () => {
  it("sends a name without the prefix as it is", () => {
    expect(openRouterModel("minimax/minimax-m3")).toBe("minimax/minimax-m3");
  });

  it("drops the prefix from a name that carries one", () => {
    expect(openRouterModel("openrouter/minimax/minimax-m3")).toBe("minimax/minimax-m3");
  });
});
