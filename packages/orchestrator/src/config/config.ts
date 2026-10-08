import { EFFORTS, HARNESSES } from "@artfct-ai/adapters/harness/types";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Duration } from "./duration";
import { GatewayProvider } from "./gateway";
import { McpServers } from "./mcp-servers";
import { Adapters } from "./adapters";

/** The time limits of one harness turn of a task. */
export const TaskTimeouts = z.object({
  /** Minutes one harness turn may run before its task fails. */
  time_elapsed_minutes: z.number().positive().default(120),
  /** Minutes a harness turn may go without a session update before it is nudged, then restarted. */
  no_progress_minutes: z.number().positive().default(10),
});

/** What a task runs on when its stage does not say, and how long it may run. */
export const TaskConfig = z.object({
  harness: z.enum(HARNESSES).default("claude-code"),
  model: z.string().default("claude-sonnet-5"),
  /** Written into the harness settings when set. Unset leaves each harness on its own default. */
  effort: z.enum(EFFORTS).optional(),
  timeouts: TaskTimeouts.prefault({}),
});

/** Idle time before a sandbox sleeps, in milliseconds after parsing. 0 never sleeps. */
export const SleepAfter = z.union([z.literal(0), Duration]);

/** The sandboxes the tasks of a workflow run in. */
export const SandboxConfig = z.object({
  sleep_after: SleepAfter.prefault("30m"),
  /**
   * Time the startup script of a sandbox may take to run the harness setup and clone the repo, in
   * milliseconds after parsing. Past it the start fails and the task restarts.
   */
  startup_timeout: Duration.prefault("10m"),
  /** Tasks one workflow may run at the same time. The agent may pick a lower number per plan. */
  max_concurrency: z.number().int().positive().default(100),
});

/** The orchestrator: its agent's model and loop limits, its task settings, and its sandboxes. */
export const OrchestratorConfig = z.object({
  /** A model on the gateway's OpenAI-compatible endpoint. */
  model: z.string().default("dynamic/orchestrator"),
  /** The gateway `model` goes through. Unset takes `adapters.gateway.provider`. */
  gateway: GatewayProvider.optional(),
  /** Extra fields on every chat completion request to `model`, sent as they are. */
  model_params: z.record(z.string(), z.json()).default({}),
  /** Tool-call steps one turn may take before it is cut off. */
  max_steps: z.number().int().positive().default(25),
  /**
   * Input tokens the provider reported for the last turn, past which the next turn compacts.
   * A tool result past it is condensed before the model reads it.
   */
  context_tokens: z.number().int().positive().default(50_000),
  /** What every summarization runs on. An unset model takes `model`. */
  summarization: z.object({ model: z.string().optional() }).prefault({}),
  /** Minutes one agent turn may take. Past it the humans get a retry message. */
  turn_timeout_minutes: z.number().positive().default(10),
  /**
   * Minutes one request to the model may take, kept well under `turn_timeout_minutes`. A
   * request held open past it is dropped and the turn retries from its last finished step.
   */
  request_timeout_minutes: z.number().positive().default(3),
  /**
   * Hours of silence, with no task working, before the agent says it is going to sleep. It
   * wakes on the next message. 0 turns the note off.
   */
  idle_hours: z.number().nonnegative().default(24),
  /**
   * The highest run number a reviewer reaches on one artifact. Past it the author's revision
   * goes on without another review, and the handover says so.
   */
  max_review_runs: z.number().int().positive().default(3),
  task: TaskConfig.prefault({}),
  sandbox: SandboxConfig.prefault({}),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfig>;

/**
 * The teams whose members may give the deployment work. `tracker_team` is a team key or id of
 * the tracker. `chat_team` is the id of the chat team. With neither, everyone who reaches the
 * bot may.
 */
export const Access = z.strictObject({
  tracker_team: z.string().min(1).optional(),
  chat_team: z.string().min(1).optional(),
});
export type Access = z.infer<typeof Access>;

/**
 * The deployment-wide settings of `artfct.yaml`. Every section has defaults. An unknown key fails,
 * so a `stages` list in it is refused, not ignored.
 */
export const Config = z.strictObject({
  adapters: Adapters.prefault({}),
  access: Access.prefault({}),
  orchestrator: OrchestratorConfig.prefault({}),
  mcp_servers: McpServers.default([]),
});
export type Config = z.infer<typeof Config>;

/** Parse the text of `artfct.yaml` into validated settings. An empty file takes every default. */
export function loadConfig(yamlText: string): Config {
  return Config.parse(parseYaml(yamlText) ?? {});
}
