import type { GatewayProvider } from "../../config/gateway";
import { orchestratorGateway } from "../../config/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  wrapLanguageModel,
  type JSONValue,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type { WorkflowRuntime } from "../../workflow/types";

/** The secrets each gateway needs, named in the error a model without them raises. */
const GATEWAY_SECRETS: Record<GatewayProvider, string> = {
  cloudflare: "CF_ACCOUNT_ID, AI_GATEWAY_ID, and AI_GATEWAY_TOKEN",
  openrouter: "OPEN_ROUTER_API_KEY",
};

/** Construction options. The orchestrator's own model ignores `params` and `gateway`. */
export type ModelOptions = {
  fetch?: typeof fetch;
  params?: Record<string, JSONValue>;
  gateway?: GatewayProvider;
};

/** The provider name. The provider reads extra request fields from `providerOptions` under it. */
const PROVIDER_NAME = "ai-gateway";

/** A fetch that gives up on one request after `timeoutMs`, on top of the caller's signal. */
export function timedFetch(base: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

/**
 * A model on a gateway's OpenAI-compatible endpoint, for example `openrouter/x-ai/grok-4.6`.
 * Without a name this is `orchestrator.model`. A name without its gateway's secrets throws.
 */
export function orchestratorModel(
  workflow: WorkflowRuntime,
  model?: string,
  options: ModelOptions = {},
): LanguageModel {
  const config = workflow.config();
  const modelName = model ?? config.orchestrator.model;
  const provider = options.gateway ?? orchestratorGateway(config);
  const gateway = workflow.gateway(provider);
  if (!gateway) {
    throw new Error(`model ${modelName} needs ${GATEWAY_SECRETS[provider]}.`);
  }
  const metadata = { workflow_id: workflow.state.workflow_id, stage: "orchestrator" };
  const route = gateway.compatRoute(modelName, metadata);
  const timeoutMs = config.orchestrator.request_timeout_minutes * 60_000;
  const sdk = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: route.baseUrl,
    headers: route.headers,
    fetch: timedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), timeoutMs),
  });
  const built = sdk(route.model);
  const { model: own, model_params: ownParams } = config.orchestrator;
  const params = modelName === own ? ownParams : (options.params ?? {});
  const fields = { ...route.fields, ...params };
  if (!Object.keys(fields).length) return built;
  return withRequestFields(built, fields);
}

/** Request fields the provider writes from an option of its own, keyed by that option. */
const OWN_OPTIONS: Record<string, string> = {
  reasoning_effort: "reasoningEffort",
  verbosity: "textVerbosity",
};

/** The model with `fields` on every request body, through the provider's `providerOptions`. */
function withRequestFields(
  model: Exclude<LanguageModel, string>,
  fields: Record<string, JSONValue>,
): LanguageModel {
  const options = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [OWN_OPTIONS[key] ?? key, value]),
  );
  const middleware: LanguageModelMiddleware = {
    transformParams: async ({ params }) => ({
      ...params,
      providerOptions: {
        ...params.providerOptions,
        [PROVIDER_NAME]: { ...params.providerOptions?.[PROVIDER_NAME], ...options },
      },
    }),
  };
  return wrapLanguageModel({ model, middleware });
}
