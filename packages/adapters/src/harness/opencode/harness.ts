import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import { planEntries } from "@artfct-ai/acp/updates";
import type { CompatRoute } from "../../gateway/types";
import {
  SANDBOX_HOME,
  type Effort,
  type HarnessAdapter,
  type HarnessCommand,
  type HarnessSetup,
  type HarnessTaskInput,
  type ModelsLineContext,
} from "../types";
import { OPENCODE_RTK_PLUGIN, OPENCODE_TODO_PLUGIN } from "./plugins";
import { todoPlan } from "./todos";

const CONFIG_DIR = `${SANDBOX_HOME}/.config/opencode`;

/**
 * OpenCode through its native `opencode acp`. It reads providers from a config file, so every
 * task gets a generated one. It sends no ACP plan update, so its todo list comes from the tool
 * its todo plugin adds.
 */
export class OpenCodeHarness implements HarnessAdapter {
  readonly name = "opencode";
  readonly instructionsFile = `${CONFIG_DIR}/AGENTS.md`;
  readonly skillsDir = `${CONFIG_DIR}/skills`;

  invokeSkill(name: string): string {
    return `Call the skill tool with id "${name}" first. Then follow the skill it returns for this task.`;
  }

  modelsLine(context: ModelsLineContext): string {
    const named = context.examples.length ? `, for example ${context.examples.join(", ")}` : "";
    return `opencode runs any model the ${context.gateway} gateway carries, named as the config names it${named}.`;
  }

  async models(): Promise<null> {
    return null;
  }

  modelRefusal(): string | null {
    return null;
  }

  command(): HarnessCommand {
    return { command: ["opencode", "acp"], env: {} };
  }

  plan(update: SessionUpdate): PlanEntry[] | null {
    return planEntries(update) ?? todoPlan(update);
  }

  setup(input: HarnessTaskInput): HarnessSetup {
    if (!input.gateway)
      return { error: "opencode needs a gateway for its model. None is configured." };
    const content = opencodeConfig(input.gateway.compat, input.effort);
    return {
      env: {},
      files: [
        { path: `${CONFIG_DIR}/opencode.json`, content },
        { path: `${CONFIG_DIR}/plugins/rtk.js`, content: OPENCODE_RTK_PLUGIN },
        { path: `${CONFIG_DIR}/plugins/todo.js`, content: OPENCODE_TODO_PLUGIN },
      ],
      commands: [],
    };
  }
}

/**
 * The generated config: one provider on the route, with the model under it. OpenCode prices the
 * session from the route's catalog, and `id` is the name the route wants on the wire.
 */
export function opencodeConfig(compat: CompatRoute, effort: Effort | null): string {
  const { catalog } = compat;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${catalog.provider}/${catalog.model}`,
    provider: {
      [catalog.provider]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: compat.baseUrl, apiKey: compat.apiKey, headers: compat.headers },
        models: {
          [catalog.model]: {
            id: compat.model,
            ...(effort ? { options: { reasoningEffort: compatEffort(effort) } } : {}),
          },
        },
      },
    },
  });
}

/** An effort as the OpenAI-compatible `reasoning_effort` takes it. Levels above high send high. */
export function compatEffort(effort: Effort): "low" | "medium" | "high" {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return "high";
}
