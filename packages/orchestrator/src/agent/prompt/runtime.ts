import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import { HARNESSES } from "@artfct-ai/adapters/harness/types";
import type { Config } from "../../config/config";

/** How the agent picks a harness and model for one task. Kept next to what it may pick from. */
export const RUNTIME_RULES = `## Harness and model per task
- The stage picks the harness and model. When a person's message names a model, the system resolves it and start_job runs the job's author on it. Do not pass harness or model for it.
- Pass harness and model to start_job only for an issue label such as \`harness: opencode\` or \`model: claude-sonnet-5\`. A model the person named beats the label, and the label beats the stage.
- start_job's result says what the author runs on. Say it in your one line back. When the result says the named model matched none clearly, name the closest models it lists and ask which one the person meant.`;

/** The harnesses and the model names each one takes, for the system prompt. */
export function runtimeLines(config: Config): string[] {
  const context = { gateway: config.providers.gateway, examples: gatewayModels(config) };
  return [
    "## Harnesses and models",
    `Harnesses: ${HARNESSES.join(", ")}.`,
    ...HARNESSES.map((name) => harnessAdapter(name).modelsLine(context)),
  ];
}

/** The gateway models the config already names, without duplicates, in config order. */
function gatewayModels(config: Config): string[] {
  const { orchestrator } = config;
  const models = [orchestrator.model, orchestrator.summarization.model ?? orchestrator.model];
  return [...new Set(models.filter((model) => model.includes("/")))];
}
