#!/usr/bin/env bun
/**
 * Runs every spec replay at the run count a pull request uses, on a random seed that each property
 * prints, for the turbo `spec:replay` task.
 * Usage, from the orchestrator package: bun scripts/properties/spec-replays.ts
 */
import { runPropertyParts, SPEC_REPLAY_FILES } from "./property-files";

let failed = false;
for (const file of Object.values(SPEC_REPLAY_FILES)) {
  const run = await runPropertyParts(file, {});
  if (run.outcome === "passed") continue;
  failed = true;
  console.error(`::error::The ${file.title} ${run.outcome === "failed" ? "failed" : "timed out"}.`);
}
process.exit(failed ? 1 : 0);
