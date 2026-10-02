import type { OpenRouterCore } from "@openrouter/sdk/core.js";
import type { Model } from "@openrouter/sdk/models/model.js";
import type { PresetWithDesignatedVersion } from "@openrouter/sdk/models/presetwithdesignatedversion.js";
import { workerdFetch } from "../../workerd-fetch";
import { OPENROUTER_PREFIX, type GatewayModel, type OpenRouterRegion } from "../types";
import { openRouterApiUrl } from "./api-url";

/** The full model list is large. Past this the caller goes on without it. */
const TIMEOUT_MS = 10_000;

/** A harness calls tools, so a model that takes none cannot run a task. */
const TOOL_CALLING = "tools";

/** The most models one page carries. The tool-calling list fits in one. */
const MODELS_PAGE_LIMIT = 1000;

/** Construction options. `serverUrl` and `fetch` are seams for tests. */
export type OpenRouterModelsOptions = {
  apiKey: string;
  region?: OpenRouterRegion;
  serverUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Every tool-calling model OpenRouter carries, and every preset on the key, each named as the
 * config names it. The SDK loads on the call.
 */
export async function openRouterModels(options: OpenRouterModelsOptions): Promise<GatewayModel[]> {
  const core = await openRouterModelsCore(options);
  const [{ modelsList }, { presetsList }, { presetsGet }] = await Promise.all([
    import("@openrouter/sdk/funcs/modelsList.js"),
    import("@openrouter/sdk/funcs/presetsList.js"),
    import("@openrouter/sdk/funcs/presetsGet.js"),
  ]);
  const [models, presets] = await Promise.all([
    modelsList(core, { supportedParameters: TOOL_CALLING, limit: MODELS_PAGE_LIMIT }),
    presetsList(core),
  ]);
  if (!models.ok) throw models.error;
  if (!presets.ok) throw presets.error;
  const detailed = await Promise.all(
    presets.value.result.data.map(async (preset) => {
      const result = await presetsGet(core, { slug: preset.slug });
      if (!result.ok) throw result.error;
      return result.value.data;
    }),
  );
  return [
    ...models.value.result.data.map(listedOpenRouterModel),
    ...detailed.flatMap(listedOpenRouterPreset),
  ];
}

/** One OpenRouter model, named with the prefix the config puts on every OpenRouter model. */
function listedOpenRouterModel(model: Model): GatewayModel {
  return {
    kind: "model",
    id: `${OPENROUTER_PREFIX}${model.id}`,
    vendor: model.id.split("/")[0]!,
    name: model.name,
    released: new Date(model.created * 1000).toISOString().slice(0, 10),
  };
}

/** One preset and the model its designated version runs. A preset that names no model is left out. */
function listedOpenRouterPreset(preset: PresetWithDesignatedVersion): GatewayModel[] {
  const model: unknown = preset.designatedVersion?.config.model;
  if (typeof model !== "string") return [];
  const name = preset.description ? `${preset.name}, ${preset.description}` : preset.name;
  return [
    {
      kind: "preset",
      id: `${OPENROUTER_PREFIX}@preset/${preset.slug}`,
      name,
      model: `${OPENROUTER_PREFIX}${model}`,
    },
  ];
}

async function openRouterModelsCore(options: OpenRouterModelsOptions): Promise<OpenRouterCore> {
  const [{ OpenRouterCore: Core }, { HTTPClient }] = await Promise.all([
    import("@openrouter/sdk/core.js"),
    import("@openrouter/sdk/lib/http.js"),
  ]);
  return new Core({
    apiKey: options.apiKey,
    serverURL: options.serverUrl ?? openRouterApiUrl(options.region),
    timeoutMs: TIMEOUT_MS,
    httpClient: new HTTPClient({ fetcher: workerdFetch(options.fetch) }),
  });
}
