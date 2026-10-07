import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import { planEntries } from "@artfct-ai/acp/updates";
import type { AnthropicRoute } from "../../gateway/types";
import { anthropicModels } from "./anthropic-models";
import {
  SANDBOX_HOME,
  type Effort,
  type HarnessAdapter,
  type HarnessCommand,
  type HarnessFile,
  type HarnessModels,
  type HarnessSetup,
  type HarnessTaskInput,
} from "../types";

/** A credential Claude Code sends to Anthropic directly, without a gateway. */
export type ClaudeCredential =
  /** Long-lived token from `claude setup-token`. Bills the owner's Claude subscription. */
  | { kind: "oauth_token"; token: string }
  /** A Claude Platform API key. Bills the key's organization. */
  | { kind: "api_key"; key: string };

/** What the Claude Code adapter takes from the deployment. */
export type ClaudeCodeOptions = {
  /** Wins over the gateway's Anthropic route when set. */
  credential: ClaudeCredential | null;
  /** A seam for tests. */
  fetch?: typeof fetch;
};

/** Anthropic's vendor id on a gateway, such as the `anthropic/` in an OpenRouter model id. */
const ANTHROPIC_VENDOR = "anthropic";

/**
 * Claude Code through the official ACP adapter over the Claude Agent SDK. It speaks the
 * Anthropic API only: a subscription token, an API key, or a gateway with an Anthropic route.
 */
export class ClaudeCodeHarness implements HarnessAdapter {
  readonly name = "claude-code";
  readonly instructionsFile = `${SANDBOX_HOME}/.claude/CLAUDE.md`;
  readonly skillsDir = `${SANDBOX_HOME}/.claude/skills`;

  constructor(private readonly options: ClaudeCodeOptions) {}

  modelsLine(): string {
    return "claude-code runs Anthropic models by their plain id, such as claude-opus-5 or claude-sonnet-5.";
  }

  invokeSkill(name: string): string {
    return `Run the \`${name}\` skill with the Skill tool first. Then follow it for this task.`;
  }

  async models(): Promise<HarnessModels> {
    return { vendor: ANTHROPIC_VENDOR, models: await anthropicModels(this.options.fetch) };
  }

  /** A gateway model name carries a provider path, which the Anthropic API cannot take. */
  modelRefusal(model: string): string | null {
    if (!model.includes("/")) return null;
    return `claude-code runs Anthropic models by their plain id. ${model} is a gateway model: run it on opencode, or pick an Anthropic id for claude-code.`;
  }

  command(model: string | undefined): HarnessCommand {
    return { command: ["claude-agent-acp"], env: model ? { ANTHROPIC_MODEL: model } : {} };
  }

  plan(update: SessionUpdate): PlanEntry[] | null {
    return planEntries(update);
  }

  setup(input: HarnessTaskInput): HarnessSetup {
    const env = { ANTHROPIC_MODEL: input.model, ...TODO_TOOLS_ENV };
    const files = input.effort ? [settingsFile(input.effort)] : [];
    const commands = [RTK_HOOK_INSTALL];
    const credential = this.options.credential;
    if (credential) return { env: { ...env, ...credentialEnv(credential) }, files, commands };
    const anthropic = input.gateway?.anthropic;
    if (anthropic) return { env: { ...env, ...routeEnv(anthropic) }, files, commands };
    const why = input.gateway
      ? "The configured gateway has no Anthropic endpoint."
      : "No gateway is configured.";
    return {
      error: `claude-code needs ANTHROPIC_API_KEY or a gateway with an Anthropic endpoint. ${why}`,
    };
  }
}

/** Enables todos on newer models */
const TODO_TOOLS_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" };

/** Adds the rtk Bash hook to the settings file and keeps what the file already holds. */
const RTK_HOOK_INSTALL = "rtk init --global --hook-only --auto-patch";

/** The settings file Claude Code reads `effortLevel` from at session start. */
function settingsFile(effort: Effort): HarnessFile {
  return {
    path: `${SANDBOX_HOME}/.claude/settings.json`,
    content: JSON.stringify({ effortLevel: effort }),
  };
}

function credentialEnv(credential: ClaudeCredential): Record<string, string> {
  switch (credential.kind) {
    case "oauth_token":
      return { CLAUDE_CODE_OAUTH_TOKEN: credential.token };
    case "api_key":
      return { ANTHROPIC_API_KEY: credential.key };
  }
}

/** Claude Code takes its route as a base URL plus custom headers, one `name: value` per line. */
function routeEnv(route: AnthropicRoute): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: route.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(route.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
  };
}
