#!/usr/bin/env bun
/**
 * The bridge with the in-process mock harness in place of a harness process. It takes the
 * arguments of the real bridge. `scripts/mock-sandbox.ts --scripted-harness` spawns it.
 */
import { harnessEnv, parseBridgeArgs } from "../packages/sandbox-bridge/src/args";
import { Bridge } from "../packages/bridge/src/bridge";
import { MockHarness } from "../packages/bridge/test/mock-harness";

const args = parseBridgeArgs(process.argv, process.env, process.cwd());
if ("error" in args) {
  console.error(args.error);
  process.exit(2);
}

const bridge = new Bridge({
  ...args,
  spec: { command: [], env: {} },
  env: harnessEnv(process.env),
  spawnHarness: (callbacks) => new MockHarness(callbacks.onMessage),
});
bridge.start().catch((error) => {
  console.error(`[bridge] fatal: ${error}`);
  process.exit(1);
});
