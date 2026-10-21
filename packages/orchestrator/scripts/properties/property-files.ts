import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";

/** A property test file, the package directory it runs from, and the runs each property in it takes per full e2e run. */
export type PropertyFile = {
  title: string;
  packageDir: string;
  path: string;
  runner: string[];
  e2eRuns: number;
};

/** One process of a property file run: the whole file, or the tests of one spec setup. */
export type PropertyPart =
  | { kind: "file" }
  | { kind: "setup"; setup: string; testNamePattern: string };

/** The outcome of one property file run, with everything it printed and the processes that hung. */
export type PropertyRun =
  | { outcome: "passed" | "failed"; output: string }
  | { outcome: "timed_out"; output: string; hungParts: PropertyPart[] };

const ORCHESTRATOR_DIR = join(import.meta.dirname, "../..");
const PACKAGES_DIR = join(ORCHESTRATOR_DIR, "..");

const SPEC_REPLAY_PATTERN = "*/src/**/*.replay{,.medium}.ts";
const STANDALONE_PROPERTY_PATTERN = "*/src/**/*.property{,.medium}.ts";

/**
 * The runs each property of a file takes in an e2e run, for a file whose count differs from the
 * 3,000 of a spec replay or the 100,000 of a standalone property file. Keys are paths under `packages/`.
 */
export const E2E_RUNS_BY_FILE: Record<string, number> = {
  "orchestrator/src/workflow/review-loop.replay.ts": 300,
  "orchestrator/src/workflow/workflow-lifecycle.replay.ts": 1000,
  "orchestrator/src/agent/turn/agent-turns.replay.medium.ts": 300,
  "adapters/src/documents/linear/held-comments.property.ts": 200_000,
  "adapters/src/documents/notion/held-comments.property.ts": 200_000,
  "cli/src/secrets.property.ts": 3_000,
  "orchestrator/src/agent/tools/condensed.property.medium.ts": 20_000,
  "orchestrator/src/decisions/screen.property.ts": 20_000,
  "orchestrator/src/oauth/token.property.medium.ts": 5_000,
  "orchestrator/src/router/identity.property.medium.ts": 50_000,
  "orchestrator/src/workflow/secrets.property.ts": 2_000,
  "ingress/src/routes/secrets.property.ts": 20_000,
};

function propertyFilesMatching(pattern: string, defaultE2eRuns: number): PropertyFile[] {
  return [...new Bun.Glob(pattern).scanSync(PACKAGES_DIR)].toSorted().map((pathUnderPackages) => {
    const packageEnd = pathUnderPackages.indexOf("/");
    const path = `./${pathUnderPackages.slice(packageEnd + 1)}`;
    return {
      title: `${pathUnderPackages} properties`,
      packageDir: pathUnderPackages.slice(0, packageEnd),
      path,
      runner: path.endsWith(".medium.ts")
        ? ["bunx", "vitest", "run", "--config", "vitest.property.config.ts"]
        : ["bun", "test"],
      e2eRuns: E2E_RUNS_BY_FILE[pathUnderPackages] ?? defaultE2eRuns,
    };
  });
}

/** The spec replay files by spec name, which the `spec:replay` task, the CI replay jobs and the mutant run use. */
export const SPEC_REPLAY_FILES: Record<string, PropertyFile> = Object.fromEntries(
  propertyFilesMatching(SPEC_REPLAY_PATTERN, 3000).map((file) => {
    const spec = basename(file.path).replace(/\.replay(\.medium)?\.ts$/, "");
    return [spec, { ...file, title: `${spec.replaceAll("-", " ")} spec replay` }];
  }),
);

/** The property test files that check logic the Quint specs do not model, for the property jobs and the mutants that name them. */
export const STANDALONE_PROPERTY_FILES: PropertyFile[] = propertyFilesMatching(
  STANDALONE_PROPERTY_PATTERN,
  100_000,
);

/** The standalone property file at a path relative to the orchestrator package, as a mutant names it. */
export function standalonePropertyFile(pathFromOrchestrator: string): PropertyFile | undefined {
  const wanted = join(ORCHESTRATOR_DIR, pathFromOrchestrator);
  return STANDALONE_PROPERTY_FILES.find(
    (file) => join(PACKAGES_DIR, file.packageDir, file.path) === wanted,
  );
}

/** A property test process that runs past this is a hang, reported with its setup and seed. */
export const PROPERTY_PROCESS_TIMEOUT_MINUTES = 20;

/** The runs each property of a file takes in an e2e run, divided by `PROPERTY_RUNS_DIVISOR` for a light run. */
function e2eRunCount(file: PropertyFile): number {
  return Math.ceil(file.e2eRuns / Number(process.env.PROPERTY_RUNS_DIVISOR ?? 1));
}

/** The command, run from the file's package directory, that repeats an e2e run exactly. */
export function propertyReplayCommand(file: PropertyFile, seed: number): string {
  return `PROPERTY_SEED=${seed} PROPERTY_RUNS=${e2eRunCount(file)} ${[...file.runner, file.path].join(" ")}`;
}

/**
 * The processes a property file runs in: one per spec setup of a replay file, or one for the
 * whole file. The process of the first setup also takes every test outside a setup.
 */
export function propertyParts(setups: string[]): PropertyPart[] {
  const [first, ...others] = setups;
  if (!first || !others.length) return [{ kind: "file" }];
  return [
    { kind: "setup", setup: first, testNamePattern: `^(?!.* on (${others.join("|")})$)` },
    ...others.map((setup) => ({
      kind: "setup" as const,
      setup,
      testNamePattern: ` on ${setup}$`,
    })),
  ];
}

/** The spec setups whose traces a property file replays, as the spec checks list them. */
function replayedSetups(file: PropertyFile): string[] {
  const listed = Bun.spawnSync(["bun", "scripts/spec/check-spec.ts", "setups"], {
    cwd: ORCHESTRATOR_DIR,
    stderr: "inherit",
  });
  const setups: Array<{ setup: string; replay: string }> = JSON.parse(listed.stdout.toString());
  return setups.filter((entry) => entry.replay === file.path).map((entry) => entry.setup);
}

/** Echoes each line of a stream with `prefix` in front of it, and returns the stream's text. */
async function echoAndCollect(
  stream: ReadableStream<Uint8Array>,
  echo: NodeJS.WriteStream,
  prefix: string,
): Promise<string> {
  const decoder = new TextDecoder();
  const echoLines = (lines: string) =>
    echo.write(
      lines
        .split("\n")
        .map((line) => `${prefix}${line}\n`)
        .join(""),
    );
  let text = "";
  let unfinishedLine = "";
  for await (const chunk of stream) {
    const decoded = decoder.decode(chunk, { stream: true });
    text += decoded;
    unfinishedLine += decoded;
    const lineEnd = unfinishedLine.lastIndexOf("\n");
    if (lineEnd === -1) continue;
    echoLines(unfinishedLine.slice(0, lineEnd));
    unfinishedLine = unfinishedLine.slice(lineEnd + 1);
  }
  const rest = decoder.decode();
  text += rest;
  unfinishedLine += rest;
  if (unfinishedLine) echoLines(unfinishedLine);
  return text;
}

/** Runs one process of a property file, and stops it once it runs past the process time limit. */
async function runPart(
  file: PropertyFile,
  vars: Record<string, string>,
  part: PropertyPart,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const testNameArgs = part.kind === "setup" ? ["-t", part.testNamePattern] : [];
  const prefix = part.kind === "setup" ? `[${part.setup}] ` : "";
  const child = Bun.spawn([...file.runner, file.path, ...testNameArgs], {
    cwd: join(PACKAGES_DIR, file.packageDir),
    env: {
      ...process.env,
      ...vars,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PROPERTY_PROCESS_TIMEOUT_MINUTES * 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    echoAndCollect(child.stdout, process.stdout, prefix),
    echoAndCollect(child.stderr, process.stderr, prefix),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, output: stdout + stderr, timedOut };
}

/** Runs one property file at its e2e run count on a seed, and echoes its output as it runs. */
export function runPropertyFile(file: PropertyFile, seed: number): Promise<PropertyRun> {
  return runPropertyParts(file, {
    PROPERTY_SEED: String(seed),
    PROPERTY_RUNS: String(e2eRunCount(file)),
  });
}

type PackageManifest = {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageManifest(packageDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(PACKAGES_DIR, packageDir, "package.json"), "utf8"));
}

const packagesWithBuiltDependencies = new Set<string>();

/**
 * Builds the workspace packages a property file's package imports from their build output, as
 * turbo does before the package's tests. It runs turbo once per package per process.
 */
function buildWorkspaceDependencies(packageDir: string): void {
  if (packagesWithBuiltDependencies.has(packageDir)) return;
  const manifest = readPackageManifest(packageDir);
  const dependencyNames = new Set(
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
  );
  const needsBuild = [...new Bun.Glob("*/package.json").scanSync(PACKAGES_DIR)]
    .map((path) => readPackageManifest(path.slice(0, path.indexOf("/"))))
    .some((dependency) => dependencyNames.has(dependency.name) && dependency.scripts?.build);
  if (needsBuild) {
    const build = Bun.spawnSync(
      [
        "bunx",
        "turbo",
        "run",
        "build",
        `--filter=${manifest.name}^...`,
        "--output-logs=errors-only",
      ],
      { cwd: ORCHESTRATOR_DIR, stdout: "inherit", stderr: "inherit" },
    );
    if (build.exitCode !== 0)
      throw new Error(`Building the dependencies of ${manifest.name} failed.`);
  }
  packagesWithBuiltDependencies.add(packageDir);
}

/**
 * Runs one property file with the property variables `vars`, and echoes its output as it runs. A
 * spec replay runs each setup in its own process, as many at once as the machine has cores. A
 * process that hangs stops alone, and the others run to their end.
 */
export async function runPropertyParts(
  file: PropertyFile,
  vars: Record<string, string>,
): Promise<PropertyRun> {
  buildWorkspaceDependencies(file.packageDir);
  const parts = propertyParts(replayedSetups(file));
  const outputs: string[] = [];
  const hungParts: PropertyPart[] = [];
  let failed = false;
  const waiting = [...parts.entries()];
  const runWaitingParts = async () => {
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      const [index, part] = next;
      const run = await runPart(file, vars, part);
      outputs[index] = run.output;
      if (run.timedOut) hungParts.push(part);
      if (run.exitCode !== 0) failed = true;
    }
  };
  const processes = Math.min(availableParallelism(), parts.length);
  await Promise.all(Array.from({ length: processes }, runWaitingParts));
  const output = outputs.join("");
  if (hungParts.length) return { outcome: "timed_out", output, hungParts };
  return { outcome: failed ? "failed" : "passed", output };
}
