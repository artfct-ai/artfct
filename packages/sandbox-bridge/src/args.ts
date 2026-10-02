import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import type { HarnessSpec } from "@artfct-ai/bridge/harness/types";
import { HARNESSES, isHarness } from "@artfct-ai/adapters/harness/types";

/** Read `--name value` from argv, then `ARTFCT_NAME` from the environment, then the fallback. */
export function readArg(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  name: string,
  fallback?: string,
): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = argv[index + 1];
  if (index >= 0 && value) return value;
  return env[`ARTFCT_${name.toUpperCase()}`] ?? fallback;
}

/** Where the bridge reads its token. Never a flag, so a process list does not show it. */
const TOKEN_ENV = "ARTFCT_TOKEN";

export type BridgeArgs = {
  harness: string;
  dial: string;
  token: string;
  cwd: string;
  model: string | undefined;
  generation: number;
};

/** The bridge's start arguments, or the usage error when `dial` or the token is missing. */
export function parseBridgeArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  defaultCwd: string,
): BridgeArgs | { error: string } {
  const dial = readArg(argv, env, "dial");
  const token = env[TOKEN_ENV];
  if (!dial || !token) {
    return {
      error: `usage: artfct-bridge --harness <${HARNESSES.join("|")}> --dial <wss url> [--cwd dir] [--model m], with the token in ${TOKEN_ENV}`,
    };
  }
  return {
    harness: readArg(argv, env, "harness", "claude-code")!,
    dial,
    token,
    cwd: readArg(argv, env, "cwd", defaultCwd)!,
    model: readArg(argv, env, "model"),
    generation: Number(readArg(argv, env, "generation", "0")),
  };
}

/** The environment the harness gets: the bridge's own, without the bridge token. */
export function harnessEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== TOKEN_ENV));
}

/** What the bridge spawns for a harness name, from its adapter, or the error for an unknown name. */
export function harnessSpec(
  name: string,
  model: string | undefined,
): HarnessSpec | { error: string } {
  if (!isHarness(name)) return { error: `unknown harness: ${name}` };
  return harnessAdapter(name).command(model);
}
