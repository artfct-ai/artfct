#!/usr/bin/env bun
/**
 * Runs the named spec replay files, or every standalone property file, at their e2e run counts on
 * `PROPERTY_SEED`, for the main and nightly property jobs.
 * `PROPERTY_RUNS_DIVISOR` divides the run count for a light run.
 * A failure or a hang writes the invariant, seed, path, and replay command to the step summary.
 * Usage: bun scripts/properties/e2e-property-test.ts <standalone|router_bindings|review_loop|workflow_lifecycle|harness_session|agent_turns|chat_acknowledgement|session_routing|feedback_routing>...
 */
import { appendFileSync } from "node:fs";
import { propertyFailureReport } from "./failure-report";
import { SPEC_REPLAY_FILES, STANDALONE_PROPERTY_FILES, runPropertyFile } from "./property-files";

const names = process.argv.slice(2);
const seed = Number(process.env.PROPERTY_SEED);
if (
  names.length === 0 ||
  !names.every((name) => name === "standalone" || name in SPEC_REPLAY_FILES) ||
  !Number.isInteger(seed)
) {
  console.error(
    `usage: PROPERTY_SEED=<integer> bun scripts/properties/e2e-property-test.ts <${["standalone", ...Object.keys(SPEC_REPLAY_FILES)].join("|")}>...`,
  );
  process.exit(2);
}

let failed = false;
const files = names.flatMap((name) =>
  name === "standalone"
    ? STANDALONE_PROPERTY_FILES
    : [SPEC_REPLAY_FILES[name as keyof typeof SPEC_REPLAY_FILES]],
);
for (const file of files) {
  const run = await runPropertyFile(file, seed);
  if (run.outcome === "passed") continue;
  failed = true;
  const report = propertyFailureReport(file, seed, run);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, report);
  console.error(`\n${report}`);
}
process.exit(failed ? 1 : 0);
