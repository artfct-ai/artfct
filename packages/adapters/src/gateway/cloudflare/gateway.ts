import { CLOUDFLARE_DEFAULT_DECISIONS_MODEL, CloudflareDecisions } from "./decisions";
import {
  OPENROUTER_PREFIX,
  type AnthropicRoute,
  type CompatRoute,
  type Decisions,
  type DecisionsModels,
  type Gateway,
  type GatewayMetadata,
  type OpenRouterRegion,
} from "../types";

const GATEWAY_HOST = "https://gateway.ai.cloudflare.com/v1";

/** The provider name for models no catalog prices. Cloudflare's own models are in none. */
const UNPRICED_PROVIDER = "gateway";

/** Gateway identity and credentials. */
export type CloudflareGatewayConfig = {
  accountId: string;
  gatewayId: string;
  /**
   * API token with `AI Gateway - Run` and `Workers AI - Read` rights. A route sends it as
   * `cf-aig-authorization`. A decisions call sends it as the bearer.
   */
  token: string;
  /** The OpenRouter key, forwarded on every `openrouter/` model. Unset refuses those models. */
  openRouterKey?: string;
  /**
   * The region OpenRouter requests must stay in. The passthrough goes to OpenRouter's global
   * host, so a region refuses every `openrouter/` model.
   */
  openRouterRegion?: OpenRouterRegion;
};

/**
 * `Gateway` over Cloudflare AI Gateway. Every request carries the gateway token and the
 * metadata. A model with the `openrouter/` prefix passes through on the OpenRouter key.
 */
export class CloudflareGateway implements Gateway {
  constructor(private readonly config: CloudflareGatewayConfig) {}

  compatRoute(model: string, metadata: GatewayMetadata): CompatRoute {
    const passthrough = model.startsWith(OPENROUTER_PREFIX);
    const key = passthrough ? this.openRouterKey(model) : null;
    return {
      baseUrl: `${this.baseUrl()}/compat`,
      model,
      apiKey: key ?? this.config.token,
      headers: {
        ...this.gatewayHeaders(metadata),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      fields: passthrough ? { usage: { include: true } } : {},
      catalog: { provider: UNPRICED_PROVIDER, model },
    };
  }

  anthropicRoute(metadata: GatewayMetadata): AnthropicRoute {
    return { baseUrl: `${this.baseUrl()}/anthropic`, headers: this.gatewayHeaders(metadata) };
  }

  decisions(models: DecisionsModels = [CLOUDFLARE_DEFAULT_DECISIONS_MODEL]): Decisions {
    const { accountId, gatewayId, token } = this.config;
    return new CloudflareDecisions({ accountId, gatewayId, token, models });
  }

  async models(): Promise<null> {
    return null;
  }

  private baseUrl(): string {
    return `${GATEWAY_HOST}/${this.config.accountId}/${this.config.gatewayId}`;
  }

  private gatewayHeaders(metadata: GatewayMetadata): Record<string, string> {
    return {
      "cf-aig-authorization": `Bearer ${this.config.token}`,
      "cf-aig-metadata": JSON.stringify(metadata),
    };
  }

  private openRouterKey(model: string): string {
    const region = this.config.openRouterRegion;
    if (region) {
      throw new Error(
        `model ${model} passes through to OpenRouter's global host, which is outside the ${region} region. Route it through the OpenRouter gateway.`,
      );
    }
    const key = this.config.openRouterKey;
    if (!key) {
      throw new Error(`model ${model} passes through to OpenRouter and needs an OpenRouter key.`);
    }
    return key;
  }
}
