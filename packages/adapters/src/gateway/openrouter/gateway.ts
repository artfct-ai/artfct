import { openRouterApiUrl } from "./api-url";
import { OPENROUTER_DEFAULT_DECISIONS_MODEL, OpenRouterDecisions } from "./decisions";
import { openRouterModels } from "./models";
import {
  OPENROUTER_PREFIX,
  type CompatRoute,
  type Decisions,
  type DecisionsModels,
  type Gateway,
  type GatewayModel,
  type OpenRouterRegion,
} from "../types";

/** OpenRouter's provider id in the models.dev catalog. */
const OPENROUTER_CATALOG = "openrouter";

/** The OpenRouter key, and the region every request stays in. Unset uses the global host. */
export type OpenRouterGatewayConfig = { apiKey: string; region?: OpenRouterRegion };

/**
 * `Gateway` straight to OpenRouter, with no gateway in between. Every request asks for the cost
 * in the usage. OpenRouter carries no metadata and has no Anthropic endpoint.
 */
export class OpenRouterGateway implements Gateway {
  constructor(private readonly config: OpenRouterGatewayConfig) {}

  compatRoute(model: string): CompatRoute {
    const name = openRouterModel(model);
    return {
      baseUrl: openRouterApiUrl(this.config.region),
      model: name,
      apiKey: this.config.apiKey,
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      fields: { usage: { include: true } },
      catalog: { provider: OPENROUTER_CATALOG, model: name },
    };
  }

  anthropicRoute(): null {
    return null;
  }

  decisions(models: DecisionsModels = [OPENROUTER_DEFAULT_DECISIONS_MODEL]): Decisions {
    return new OpenRouterDecisions({ ...this.config, models });
  }

  models(): Promise<GatewayModel[]> {
    return openRouterModels(this.config);
  }
}

/** The name OpenRouter knows a configured model by: the same name without the `openrouter/` prefix. */
export function openRouterModel(model: string): string {
  return model.startsWith(OPENROUTER_PREFIX) ? model.slice(OPENROUTER_PREFIX.length) : model;
}
