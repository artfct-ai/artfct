#!/usr/bin/env bun
/**
 * Runs every spec replay, or every standalone property file, at the run count a pull request uses,
 * on a random seed that each property prints. The turbo `spec:replay` task runs the replays, and
 * the pull request property job runs the standalone property files.
 * Usage, from the orchestrator package: bun scripts/properties/pull-request-runs.ts <replays|standalone>
 */
import { runPropertyParts, SPEC_REPLAY_FILES, STANDALONE_PROPERTY_FILES } from "./property-files";

const kind = process.argv[2];
if (kind !== "replays" && kind !== "standalone") {
  console.error("usage: bun scripts/properties/pull-request-runs.ts <replays|standalone>");
  process.exit(2);
}

let failed = false;
const files = kind === "replays" ? Object.values(SPEC_REPLAY_FILES) : STANDALONE_PROPERTY_FILES;
for (const file of files) {
  const run = await runPropertyParts(file, {});
  if (run.outcome === "passed") continue;
  failed = true;
  console.error(`::error::The ${file.title} ${run.outcome === "failed" ? "failed" : "timed out"}.`);
}
process.exit(failed ? 1 : 0);
