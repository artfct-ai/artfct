#!/usr/bin/env bun
/**
 * Runs one property file at its e2e run count on `PROPERTY_SEED`, for the CI property and replay jobs.
 * `PROPERTY_RUNS_DIVISOR` divides the run count for a light run.
 * A failure or a hang writes the invariant, seed, path, and replay command to the step summary.
 * Usage: bun scripts/properties/e2e-property-test.ts <workflow|agent_turn|router_bindings|review_loop|workflow_lifecycle|harness_session|agent_turns>
 */
import { appendFileSync } from "node:fs";
import { propertyFailureReport } from "./failure-report";
import { PROPERTY_FILES, runPropertyFile } from "./property-files";

const name = process.argv[2];
const seed = Number(process.env.PROPERTY_SEED);
if (!(name && name in PROPERTY_FILES) || !Number.isInteger(seed)) {
  console.error(
    `usage: PROPERTY_SEED=<integer> bun scripts/properties/e2e-property-test.ts <${Object.keys(PROPERTY_FILES).join("|")}>`,
  );
  process.exit(2);
}

const file = PROPERTY_FILES[name as keyof typeof PROPERTY_FILES];
const run = await runPropertyFile(file, seed);
if (run.outcome !== "passed") {
  const report = propertyFailureReport(file, seed, run);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, report);
  console.error(`\n${report}`);
  process.exit(1);
}
