import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config";
import { orchestratorGateway } from "./gateway";

describe("gateways", () => {
  describe("a config that names no region", () => {
    it("leaves OpenRouter on its global host", () => {
      expect(loadConfig("").gateways.openrouter.region).toBeUndefined();
    });
  });

  describe("a config with an OpenRouter region", () => {
    it("carries the region", () => {
      expect(
        loadConfig("gateways: { openrouter: { region: eu } }").gateways.openrouter.region,
      ).toBe("eu");
    });
  });

  describe("a region OpenRouter does not serve", () => {
    it("refuses to load the config", () => {
      expect(() => loadConfig("gateways: { openrouter: { region: europe } }")).toThrow();
    });
  });

  describe("a setting the schema does not know", () => {
    it("refuses to load the config", () => {
      expect(() => loadConfig("gateways: { openrouter: { regoin: eu } }")).toThrow();
    });
  });
});

describe("orchestratorGateway", () => {
  describe("a config that names no gateway", () => {
    it("falls back to the default gateway", () => {
      expect(orchestratorGateway(loadConfig(""))).toBe("cloudflare");
    });
  });

  describe("a config with a gateway provider", () => {
    it("takes the provider", () => {
      expect(orchestratorGateway(loadConfig("providers: { gateway: openrouter }"))).toBe(
        "openrouter",
      );
    });
  });

  describe("a config with a gateway on the orchestrator", () => {
    const config = loadConfig("orchestrator: { gateway: openrouter }");

    it("takes the orchestrator's own setting", () => {
      expect(orchestratorGateway(config)).toBe("openrouter");
    });

    it("leaves the gateway provider alone", () => {
      expect(config.providers.gateway).toBe("cloudflare");
    });
  });

  describe("a gateway the schema does not know", () => {
    it("refuses to load the config", () => {
      expect(() => loadConfig("providers: { gateway: bedrock }")).toThrow();
    });
  });
});
