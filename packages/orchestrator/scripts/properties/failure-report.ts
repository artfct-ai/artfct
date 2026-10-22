import {
  PROPERTY_PROCESS_TIMEOUT_MINUTES,
  propertyReplayCommand,
  type PropertyFile,
  type PropertyRun,
} from "./property-files";

/** One counterexample fast-check reported: the invariant or property test it broke and where to find it again. */
export type PropertyFailure = { invariant: string; seed: number; path: string };

const FAST_CHECK_REPORT = /\{ seed: (-?\d+), path: "([^"]*)"/;
const INVARIANT_ERROR = /^(?:error|Caused by: Error): (\w+: .*)$/;
const BUN_FAILED_TEST = /^\(fail\) (.+?)(?: \[[^\]]+\])?$/;
const VITEST_FAILED_TEST = /^FAIL +\S+ > (.+)$/;

/**
 * The counterexamples in the output of `bun test` or `vitest run`, each once. A counterexample
 * without an invariant error is named by its failing test.
 */
export function propertyFailures(output: string): PropertyFailure[] {
  const failures = new Map<string, PropertyFailure>();
  let report: RegExpMatchArray | null = null;
  let vitestTest: string | null = null;
  const recordFailure = (invariant: string) => {
    if (!report) return;
    const failure = { invariant, seed: Number(report[1]), path: report[2]! };
    failures.set(`${failure.seed} ${failure.path} ${failure.invariant}`, failure);
    report = null;
  };
  for (const line of output.split("\n")) {
    const reportMatch = line.match(FAST_CHECK_REPORT);
    if (reportMatch) {
      report = reportMatch;
      continue;
    }
    const trimmed = line.trim();
    const failedTest = trimmed.match(INVARIANT_ERROR) ?? trimmed.match(BUN_FAILED_TEST);
    if (failedTest) {
      recordFailure(failedTest[1]!);
      continue;
    }
    const vitestMatch = trimmed.match(VITEST_FAILED_TEST);
    if (!vitestMatch) continue;
    if (vitestTest) recordFailure(vitestTest);
    vitestTest = vitestMatch[1]!;
  }
  if (vitestTest) recordFailure(vitestTest);
  return [...failures.values()];
}

/** The heading of the step summary of a run that did not pass, which names each setup that hung. */
function propertyFailureHeading(file: PropertyFile, seed: number, run: PropertyRun): string {
  if (run.outcome !== "timed_out") return `### The ${file.title} failed on seed ${seed}`;
  const hungSetups = run.hungParts.flatMap((part) => (part.kind === "setup" ? [part.setup] : []));
  const where = hungSetups.length ? ` on ${hungSetups.join(", ")}` : "";
  return `### The ${file.title} timed out${where} after ${PROPERTY_PROCESS_TIMEOUT_MINUTES} minutes on seed ${seed}`;
}

/** The step summary of an e2e property test run that did not pass. */
export function propertyFailureReport(file: PropertyFile, seed: number, run: PropertyRun): string {
  const heading = propertyFailureHeading(file, seed, run);
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
    `Replay it from \`packages/${file.packageDir}\`:`,
    `\`\`\`sh\n${propertyReplayCommand(file, seed)}\n\`\`\``,
    "",
  ].join("\n\n");
}
