import { join } from "node:path";
import { checkAccess } from "./access";
import { checkCloudflareCredential } from "./cloudflare";
import { checkDeploymentConfig } from "./deployment-config";
import { checkDocumentsCredential } from "./documents-credential";
import { checkSandboxImage } from "./sandbox-image";
import { describeError } from "../describe-error";
import { checkSkills } from "./skills";
import type { CheckOutcome, CheckReport, CheckEnvironment } from "./types";

async function runCheck(
  check: string,
  run: () => CheckOutcome | Promise<CheckOutcome>,
): Promise<CheckReport> {
  try {
    return { check, ...(await run()) };
  } catch (error) {
    return { check, outcome: "failed", problems: [describeError(error)] };
  }
}

/**
 * Run every preflight check on a deployment repo. A check that throws is reported as failed.
 * Without `runWrangler`, the Cloudflare credential check is skipped.
 */
export function runChecks(environment: CheckEnvironment): Promise<CheckReport[]> {
  const { repoDir, runWrangler } = environment;
  const configDir = join(repoDir, "orchestrator");
  return Promise.all([
    runCheck("Cloudflare credential", () =>
      runWrangler
        ? checkCloudflareCredential(runWrangler)
        : { outcome: "skipped", detail: "--offline skips it" },
    ),
    runCheck("config", () => checkDeploymentConfig(configDir)),
    runCheck("documents credential", () => checkDocumentsCredential(configDir)),
    runCheck("access", () => checkAccess(configDir)),
    runCheck("skills", () => checkSkills(configDir)),
    runCheck("sandbox image", () => checkSandboxImage(repoDir)),
  ]);
}

function formatProblems(label: string, check: string, problems: string[]): string {
  const lines = problems.map((problem) => `      ${problem.replaceAll("\n", "\n      ")}`);
  return [`${label}  ${check}`, ...lines].join("\n");
}

function formatCheckReport(report: CheckReport): string {
  switch (report.outcome) {
    case "passed":
      return `ok    ${report.check}: ${report.detail}`;
    case "skipped":
      return `skip  ${report.check}: ${report.detail}`;
    case "warned":
      return formatProblems("WARN", report.check, report.problems);
    case "failed":
      return formatProblems("FAIL", report.check, report.problems);
    default: {
      const unreachable: never = report;
      throw new Error(`unhandled check outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The report of `artfct check`: one line per check, and each problem under the check that found it. */
export function formatChecksReport(reports: CheckReport[]): string {
  return `${reports.map(formatCheckReport).join("\n")}\n`;
}
