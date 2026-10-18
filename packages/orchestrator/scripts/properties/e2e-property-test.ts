#!/usr/bin/env bun
/**
 * Runs one spec replay file at its e2e run count on `PROPERTY_SEED`, for the CI and nightly replay jobs.
 * `PROPERTY_RUNS_DIVISOR` divides the run count for a light run.
 * A failure or a hang writes the invariant, seed, path, and replay command to the step summary.
 * Usage: bun scripts/properties/e2e-property-test.ts <router_bindings|review_loop|workflow_lifecycle|harness_session|agent_turns|chat_acknowledgement|session_routing|feedback_routing>
 */
import { appendFileSync } from "node:fs";
import { propertyFailureReport } from "./failure-report";
import { SPEC_REPLAY_FILES, runPropertyFile } from "./property-files";

const name = process.argv[2];
const seed = Number(process.env.PROPERTY_SEED);
if (!(name && name in SPEC_REPLAY_FILES) || !Number.isInteger(seed)) {
  console.error(
    `usage: PROPERTY_SEED=<integer> bun scripts/properties/e2e-property-test.ts <${Object.keys(SPEC_REPLAY_FILES).join("|")}>`,
  );
  process.exit(2);
}

const file = SPEC_REPLAY_FILES[name as keyof typeof SPEC_REPLAY_FILES];
const run = await runPropertyFile(file, seed);
if (run.outcome !== "passed") {
  const report = propertyFailureReport(file, seed, run);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, report);
  console.error(`\n${report}`);
  process.exit(1);
}
