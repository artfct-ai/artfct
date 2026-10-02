#!/usr/bin/env bun
import { Bridge } from "@artfct-ai/bridge/bridge";
import { harnessEnv, harnessSpec, parseBridgeArgs } from "./args";

const args = parseBridgeArgs(process.argv, process.env, process.cwd());
if ("error" in args) {
  console.error(args.error);
  process.exit(2);
}

const spec = harnessSpec(args.harness, args.model);
if ("error" in spec) {
  console.error(spec.error);
  process.exit(2);
}

const bridge = new Bridge({ ...args, spec, env: harnessEnv(process.env) });
bridge.start().catch((error) => {
  console.error(`[bridge] fatal: ${error}`);
  process.exit(1);
});
