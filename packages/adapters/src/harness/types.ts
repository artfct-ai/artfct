/**
 * The harness capability: the coding agent a sandbox launches and talks ACP to. One adapter
 * per harness owns its command, auth modes, task setup, instructions file, and todo list.
 */
import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AnthropicRoute, CompatRoute, ListedModel } from "../gateway/types";

/** Every harness an adapter exists for. */
export const HARNESSES = ["claude-code", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

/** True when `name` names a harness an adapter exists for. */
export function isHarness(name: string): name is Harness {
  return (HARNESSES as readonly string[]).includes(name);
}

/** The effort levels a harness adapter maps to its own settings. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * The home directory of the unprivileged user the sandbox image runs as. Every harness file
 * lives under it.
 */
export const SANDBOX_HOME = "/home/node";

/** One file of a skill. `path` is relative to the skill directory, such as `scripts/fill.py`. */
export type SkillFile = { path: string; content: string };

/** One skill: the install directory name and every file it holds, `SKILL.md` among them. */
export type Skill = { name: string; files: readonly SkillFile[] };

/** The routes the gateway gave one task. */
export type GatewayRoutes = { anthropic: AnthropicRoute | null; compat: CompatRoute };

/** What one task gives the harness. */
export type HarnessTaskInput = {
  /** The model as the config names it. */
  model: string;
  /** How hard the model thinks, or null to leave the harness on its own default. */
  effort: Effort | null;
  /** `owner/name` of the repository, or null when the workflow knows none. */
  repoFull: string | null;
  /** Routes through the deployment's gateway, or null without one. */
  gateway: GatewayRoutes | null;
};

/** A file the sandbox writes before the harness starts. `path` is absolute, under `SANDBOX_HOME`. */
export type HarnessFile = { path: string; content: string };

/**
 * The env, files, and commands one task needs, or why the harness cannot run it. The sandbox
 * runs each command in a shell after it writes the files and before the harness starts.
 */
export type HarnessSetup =
  | { env: Record<string, string>; files: HarnessFile[]; commands: string[] }
  | { error: string };

/** What the bridge spawns. */
export type HarnessCommand = { command: string[]; env: Record<string, string> };

/** What the system prompt line about a harness may mention. */
export type ModelsLineContext = {
  /** The gateway name sandboxes route through. */
  gateway: string;
  /** Gateway models the config already names, as examples. */
  examples: string[];
};

/** The models a harness runs by their vendor's own ids, and that vendor, as a gateway names it. */
export type HarnessModels = { vendor: string; models: ListedModel[] };

/** What the orchestrator and the bridge ask of a harness. */
export interface HarnessAdapter {
  readonly name: Harness;
  /** The home-level instructions file it reads before the repository's own. */
  readonly instructionsFile: string;
  /** User-scoped directory where the harness finds skills. */
  readonly skillsDir: string;
  /** Short instruction that tells this harness to run the named skill. */
  invokeSkill(name: string): string;
  /** One line for the orchestrator's system prompt on the models the harness runs. */
  modelsLine(context: ModelsLineContext): string;
  /** The models the harness runs by their own ids, or null when it runs the gateway's models. */
  models(): Promise<HarnessModels | null>;
  /** Why the harness cannot run `model`, or null when it can. */
  modelRefusal(model: string): string | null;
  /** The ACP command the bridge spawns, with the env only that process needs. */
  command(model: string | undefined): HarnessCommand;
  /** The env, files, and commands for one task. */
  setup(input: HarnessTaskInput): HarnessSetup;
  /** The harness's todo list in an update, or null when the update carries none. */
  plan(update: SessionUpdate): PlanEntry[] | null;
}
