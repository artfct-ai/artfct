import {
  PROPERTY_FILE_TIMEOUT_MINUTES,
  propertyReplayCommand,
  type PropertyFile,
  type PropertyRun,
} from "./property-files";

/** One counterexample fast-check reported: the invariant it broke and where to find it again. */
export type PropertyFailure = { invariant: string; seed: number; path: string };

const FAST_CHECK_REPORT = /\{ seed: (-?\d+), path: "([^"]*)"/;
const INVARIANT_ERROR = /^(?:error|Caused by: Error): (\w+: .*)$/;

/** The counterexamples in the output of `bun test` or `vitest run`, each once. */
export function propertyFailures(output: string): PropertyFailure[] {
  const failures = new Map<string, PropertyFailure>();
  let report: RegExpMatchArray | null = null;
  for (const line of output.split("\n")) {
    const reportMatch = line.match(FAST_CHECK_REPORT);
    if (reportMatch) {
      report = reportMatch;
      continue;
    }
    const errorMatch = line.trim().match(INVARIANT_ERROR);
    if (!report || !errorMatch) continue;
    const failure = { invariant: errorMatch[1]!, seed: Number(report[1]), path: report[2]! };
    failures.set(`${failure.seed} ${failure.path} ${failure.invariant}`, failure);
    report = null;
  }
  return [...failures.values()];
}

/** The step summary of an e2e property test run that did not pass. */
export function propertyFailureReport(file: PropertyFile, seed: number, run: PropertyRun): string {
  const heading =
    run.outcome === "timed_out"
      ? `### The ${file.title} timed out after ${PROPERTY_FILE_TIMEOUT_MINUTES} minutes on seed ${seed}`
      : `### The ${file.title} failed on seed ${seed}`;
  const failures = propertyFailures(run.output);
  const table = failures.length
    ? [
        "| Invariant | Seed | Path |",
        "| --- | --- | --- |",
        ...failures.map(
          (failure) =>
            `| ${failure.invariant.replaceAll("|", "\\|")} | ${failure.seed} | \`${failure.path}\` |`,
        ),
      ].join("\n")
    : "fast-check did not report a counterexample. Read the step log.";
  return [
    heading,
    table,
    "Replay it from the orchestrator package:",
    `\`\`\`sh\n${propertyReplayCommand(file, seed)}\n\`\`\``,
    "",
  ].join("\n\n");
}
