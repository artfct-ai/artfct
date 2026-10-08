import { OPENROUTER_REGIONS, type DecisionsModels } from "@artfct-ai/adapters/gateway/types";
import { z } from "zod";
import type { Config } from "./config";

/**
 * Which gateway a model call goes through. `cloudflare` is Cloudflare AI Gateway. `openrouter`
 * is OpenRouter direct, for a model named `openrouter/<vendor>/<model>`.
 */
export const GatewayProvider = z.enum(["cloudflare", "openrouter"]);
export type GatewayProvider = z.infer<typeof GatewayProvider>;

/** The gateway every task sandbox routes through, and the orchestrator unless it names its own. */
export const GatewayAdapter = z.strictObject({
  provider: GatewayProvider.default("cloudflare"),
  /** The region every OpenRouter request stays in. Unset uses the global host. */
  region: z.enum(OPENROUTER_REGIONS).optional(),
});
export type GatewayAdapter = z.infer<typeof GatewayAdapter>;

/** The gateway the orchestrator's own model goes through: its own setting, or the provider. */
export function orchestratorGateway(config: Config): GatewayProvider {
  return config.orchestrator.gateway ?? config.adapters.gateway.provider;
}

/** One decisions model, or an ordered list of them, read as the list a call tries in order. */
export const DecisionsModelSetting = z.union([
  z
    .string()
    .min(1)
    .transform((model): DecisionsModels => [model]),
  z.tuple([z.string().min(1)], z.string().min(1)),
]);
