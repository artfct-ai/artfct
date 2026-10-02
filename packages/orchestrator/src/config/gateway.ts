import { OPENROUTER_REGIONS } from "@artfct-ai/adapters/gateway/types";
import { z } from "zod";
import type { Config } from "./config";

/**
 * Which gateway a model call goes through. `cloudflare` is Cloudflare AI Gateway. `openrouter`
 * is OpenRouter direct, for a model named `openrouter/<vendor>/<model>`.
 */
export const GatewayProvider = z.enum(["cloudflare", "openrouter"]);
export type GatewayProvider = z.infer<typeof GatewayProvider>;

/** The settings of each gateway that are not secrets. An unknown key fails. */
export const Gateways = z.strictObject({
  openrouter: z
    .strictObject({
      /** The region every OpenRouter request stays in. Unset uses the global host. */
      region: z.enum(OPENROUTER_REGIONS).optional(),
    })
    .prefault({}),
});
export type Gateways = z.infer<typeof Gateways>;

/** The gateway the orchestrator's own model goes through: its own setting, or the provider. */
export function orchestratorGateway(config: Config): GatewayProvider {
  return config.orchestrator.gateway ?? config.providers.gateway;
}
