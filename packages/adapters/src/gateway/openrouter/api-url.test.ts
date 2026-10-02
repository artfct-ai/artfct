import { describe, expect, it } from "bun:test";
import { openRouterApiUrl, openRouterOrigin } from "./api-url";

describe("openRouterOrigin", () => {
  it("is the global host without a region", () => {
    expect(openRouterOrigin()).toBe("https://openrouter.ai");
  });

  it("is the host of the region", () => {
    expect(openRouterOrigin("eu")).toBe("https://eu.openrouter.ai");
  });
});

describe("openRouterApiUrl", () => {
  it("is the API of the global host without a region", () => {
    expect(openRouterApiUrl()).toBe("https://openrouter.ai/api/v1");
  });

  it("is the API of the host of the region", () => {
    expect(openRouterApiUrl("us")).toBe("https://us.openrouter.ai/api/v1");
  });
});
