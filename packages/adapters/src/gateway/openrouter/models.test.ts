import { describe, expect, test } from "bun:test";
import { fetchHeader, fetchUrl } from "../../../test/fetch";
import { openRouterModels } from "./models";

await Promise.all([
  import("@openrouter/sdk/funcs/modelsList.js"),
  import("@openrouter/sdk/funcs/presetsList.js"),
  import("@openrouter/sdk/funcs/presetsGet.js"),
  import("@openrouter/sdk/core.js"),
  import("@openrouter/sdk/lib/http.js"),
]);

const GLM = {
  id: "z-ai/glm-5.3",
  canonical_slug: "z-ai/glm-5.3",
  name: "Z.ai: GLM 5.3",
  created: 1_790_000_000,
  context_length: 200_000,
  architecture: {
    modality: "text->text",
    input_modalities: ["text"],
    output_modalities: ["text"],
    tokenizer: "Other",
    instruct_type: null,
  },
  pricing: { prompt: "0.000001", completion: "0.000002" },
  top_provider: { context_length: 200_000, max_completion_tokens: null, is_moderated: false },
  per_request_limits: null,
  supported_parameters: ["tools"],
  default_parameters: null,
  supported_voices: null,
  links: { details: "/api/v1/models/z-ai/glm-5.3/endpoints" },
};

const PRESET = {
  id: "preset-1",
  creator_user_id: "user_1",
  workspace_id: null,
  name: "glm5.3",
  slug: "glm5-3",
  description: "latency optimized",
  status: "active",
  designated_version_id: "version-1",
  created_at: "2026-09-22T18:19:38.779Z",
  updated_at: "2026-09-23T13:50:47.753Z",
  status_updated_at: null,
};

const DESIGNATED = {
  id: "version-1",
  preset_id: "preset-1",
  creator_id: "user_1",
  version: 2,
  system_prompt: null,
  config: { model: "z-ai/glm-5.3" },
  created_at: "2026-09-22T18:19:38.779Z",
  updated_at: "2026-09-23T13:50:47.753Z",
};

type Seen = { url: string; authorization: string | null };

function openRouterAnswering() {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = fetchUrl(request);
    seen.push({ url, authorization: fetchHeader(request, "authorization") });
    const path = new URL(url).pathname;
    if (path === "/api/v1/models") {
      return Response.json({ data: [GLM], total_count: 1, links: { next: null } });
    }
    if (path === "/api/v1/presets") return Response.json({ data: [PRESET], total_count: 1 });
    if (path === "/api/v1/presets/glm5-3") {
      return Response.json({ data: { ...PRESET, designated_version: DESIGNATED } });
    }
    return Response.json({ error: { code: 404, message: "no" } }, { status: 404 });
  };
  return { fetch: fake, seen };
}

describe("openRouterModels", () => {
  test("asks for the tool-calling models, the presets, and each preset's designated version", async () => {
    const { fetch, seen } = openRouterAnswering();

    await openRouterModels({ apiKey: "key", serverUrl: "https://router.test/api/v1", fetch });

    expect(seen.map((request) => request.url).toSorted()).toEqual([
      "https://router.test/api/v1/models?limit=1000&offset=0&supported_parameters=tools",
      "https://router.test/api/v1/presets",
      "https://router.test/api/v1/presets/glm5-3",
    ]);
    expect(seen.every((request) => request.authorization === "Bearer key")).toBe(true);
  });

  test("reads the models and the presets from the host of its region", async () => {
    const { fetch, seen } = openRouterAnswering();

    await openRouterModels({ apiKey: "key", region: "us", fetch });

    expect(seen.map((request) => new URL(request.url).origin)).toEqual([
      "https://us.openrouter.ai",
      "https://us.openrouter.ai",
      "https://us.openrouter.ai",
    ]);
  });

  test("names every model and preset as the config names it, and a preset by the model it runs", async () => {
    const { fetch } = openRouterAnswering();

    const models = await openRouterModels({
      apiKey: "key",
      serverUrl: "https://router.test/api/v1",
      fetch,
    });

    expect(models).toEqual([
      {
        kind: "model",
        id: "openrouter/z-ai/glm-5.3",
        vendor: "z-ai",
        name: "Z.ai: GLM 5.3",
        released: "2026-09-21",
      },
      {
        kind: "preset",
        id: "openrouter/@preset/glm5-3",
        name: "glm5.3, latency optimized",
        model: "openrouter/z-ai/glm-5.3",
      },
    ]);
  });
});
