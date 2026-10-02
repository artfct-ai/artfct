import { describeError } from "../describe-error";
import { copyPackagedTemplate } from "./packaged-template";
import type { InitEnvironment, InitReport } from "./types";

const INSTALL_GUIDE = "https://github.com/artfct-ai/artfct/blob/main/docs/index.md";

const CREATE_DATABASE_ARGS = [
  "d1",
  "create",
  "artfct",
  "--binding",
  "DB",
  "--update-config",
  "--config",
  "orchestrator/wrangler.jsonc",
];

type InitStep = {
  step: string;
  recovery: string;
  run: (environment: InitEnvironment) => Promise<void>;
};

const INIT_STEPS: InitStep[] = [
  {
    step: "Copy the template into the deployment repo",
    recovery: "Run artfct init again in a directory without those entries.",
    run: async ({ templateDir, repoDir }) => copyPackagedTemplate(templateDir, repoDir),
  },
  {
    step: "Create the D1 database and write its id into the orchestrator config",
    recovery: `Fix the problem, then create the database by hand:\nwrangler ${CREATE_DATABASE_ARGS.join(" ")}`,
    run: async ({ runWrangler }) => {
      const exitCode = await runWrangler(CREATE_DATABASE_ARGS);
      if (exitCode !== 0) throw new Error(`wrangler d1 create exited with ${exitCode}.`);
    },
  },
];

/** Scaffold a deployment repo from the template and create its D1 database. It leaves the install and the commit to the person. */
export async function runInit(environment: InitEnvironment): Promise<InitReport> {
  for (const { step, recovery, run } of INIT_STEPS) {
    environment.announceStep(step);
    try {
      await run(environment);
    } catch (error) {
      return { outcome: "failed", step, problem: describeError(error), recovery };
    }
  }
  return { outcome: "done" };
}

/** The last lines `artfct init` prints: what stopped it and how to recover, or what to do next. */
export function formatInitReport(report: InitReport): string {
  if (report.outcome === "done") {
    return `Scaffolded the deployment repo. Install its dependencies with your package manager and commit the files with the lockfile. Then follow ${INSTALL_GUIDE} from step 2.\n`;
  }
  const indented = [report.problem, report.recovery].join("\n").replaceAll("\n", "\n      ");
  return `FAIL  ${report.step}\n      ${indented}\n`;
}
