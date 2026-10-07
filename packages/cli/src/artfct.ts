#!/usr/bin/env node
import { join } from "node:path";
import { ARTFCT_USAGE, parseCommand } from "./command";
import { connectGithubApp } from "./connect/code/github/connect";
import { exchangeGithubManifestCode } from "./connect/code/github/exchange";
import { describeError } from "./describe-error";
import { formatChecksReport, runChecks } from "./check/check";
import { formatInitReport, runInit } from "./init/init";
import { openBrowser } from "./open-browser";
import { runInteractiveProcess, runProcess } from "./process";

const command = parseCommand(process.argv.slice(2));
switch (command.kind) {
  case "help":
    process.stdout.write(ARTFCT_USAGE);
    break;
  case "invalid":
    process.stderr.write(`${command.message}\n\n${ARTFCT_USAGE}`);
    process.exitCode = 2;
    break;
  case "check": {
    const repoDir = process.cwd();
    const reports = await runChecks({
      repoDir,
      runWrangler: command.offline
        ? null
        : (args) => runProcess("npx", ["--no", "wrangler", ...args], repoDir),
    });
    process.stdout.write(formatChecksReport(reports));
    if (reports.some((report) => report.outcome === "failed")) process.exitCode = 1;
    break;
  }
  case "init": {
    const repoDir = process.cwd();
    const report = await runInit({
      repoDir,
      templateDir: join(import.meta.dirname, "template"),
      runWrangler: (args) => runInteractiveProcess("npx", ["--yes", "wrangler", ...args], repoDir),
      announceStep: (step) => process.stdout.write(`==> ${step}\n`),
    });
    process.stdout.write(formatInitReport(report));
    if (report.outcome === "failed") process.exitCode = 1;
    break;
  }
  case "connect-code":
    try {
      await connectGithubApp({
        repoDir: process.cwd(),
        org: command.org,
        openBrowser,
        exchangeManifestCode: exchangeGithubManifestCode,
        log: (line) => process.stdout.write(`${line}\n`),
      });
      process.stdout.write(
        "Upload the secrets with the command in the header of each .dev.vars file.\n",
      );
    } catch (error) {
      process.stderr.write(`${describeError(error)}\n`);
      process.exitCode = 1;
    }
    break;
}
