import type { OpenRouterRegion } from "../types";

/** The OpenRouter host: the global one, or the one that keeps a request inside `region`. */
export function openRouterOrigin(region?: OpenRouterRegion): string {
  return region ? `https://${region}.openrouter.ai` : "https://openrouter.ai";
}

/** The base URL of OpenRouter's API on the host of `region`, or on the global host. */
export function openRouterApiUrl(region?: OpenRouterRegion): string {
  return `${openRouterOrigin(region)}/api/v1`;
}
