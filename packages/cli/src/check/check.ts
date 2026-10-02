import { join } from "node:path";
import { checkAccess } from "./access";
import { checkCloudflareCredential } from "./cloudflare";
import { checkDeploymentConfig } from "./deployment-config";
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

/** Run every preflight check on a deployment repo. A check that throws is reported as failed. */
export function runChecks(environment: CheckEnvironment): Promise<CheckReport[]> {
  const { repoDir, runWrangler } = environment;
  const configDir = join(repoDir, "orchestrator");
  return Promise.all([
    runCheck("Cloudflare credential", () => checkCloudflareCredential(runWrangler)),
    runCheck("config", () => checkDeploymentConfig(configDir)),
    runCheck("access", () => checkAccess(configDir)),
    runCheck("skills", () => checkSkills(configDir)),
    runCheck("sandbox image", () => checkSandboxImage(repoDir)),
  ]);
}

function formatCheckReport(report: CheckReport): string {
  if (report.outcome === "passed") return `ok    ${report.check}: ${report.detail}`;
  const problems = report.problems.map(
    (problem) => `      ${problem.replaceAll("\n", "\n      ")}`,
  );
  return [`FAIL  ${report.check}`, ...problems].join("\n");
}

/** The report of `artfct check`: one line per check, and each problem under the check that found it. */
export function formatChecksReport(reports: CheckReport[]): string {
  return `${reports.map(formatCheckReport).join("\n")}\n`;
}
