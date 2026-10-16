import { join } from "node:path";

/** A property test file and the runs each property in it takes per e2e property test shard. */
export type PropertyFile = { title: string; path: string; runner: string[]; e2eRuns: number };

/** The outcome of one property file run, with everything it printed. */
export type PropertyRun = { outcome: "passed" | "failed" | "timed_out"; output: string };

/** The property test files the e2e property test job shards and the nightly mutant run. */
export const PROPERTY_FILES = {
  workflow: {
    title: "workflow properties",
    path: "src/workflow/invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 1250,
  },
  agent_turn: {
    title: "agent turn property",
    path: "src/agent/turn/turn-invariants.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 2000,
  },
  router: {
    title: "router property",
    path: "src/router/route-invariants.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 1000,
  },
  router_bindings: {
    title: "router bindings spec replay",
    path: "src/router/router-bindings-replay.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
  review_loop: {
    title: "review loop spec replay",
    path: "src/workflow/review-loop-replay.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 300,
  },
  workflow_lifecycle: {
    title: "workflow lifecycle spec replay",
    path: "src/workflow/workflow-lifecycle-replay.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 1000,
  },
} satisfies Record<string, PropertyFile>;

/** A property file run past this is a hang, reported with its seed. */
export const PROPERTY_FILE_TIMEOUT_MINUTES = 20;

const ORCHESTRATOR_DIR = join(import.meta.dirname, "../..");

/** The command, run from the orchestrator package, that repeats an e2e run exactly. */
export function propertyReplayCommand(file: PropertyFile, seed: number): string {
  return `PROPERTY_SEED=${seed} PROPERTY_RUNS=${file.e2eRuns} ${[...file.runner, file.path].join(" ")}`;
}

async function echoAndCollect(stream: ReadableStream<Uint8Array>, echo: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    echo.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Runs one property file at its e2e run count on a seed, and echoes its output as it runs. */
export async function runPropertyFile(file: PropertyFile, seed: number): Promise<PropertyRun> {
  const child = Bun.spawn([...file.runner, file.path], {
    cwd: ORCHESTRATOR_DIR,
    env: {
      ...process.env,
      PROPERTY_SEED: String(seed),
      PROPERTY_RUNS: String(file.e2eRuns),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PROPERTY_FILE_TIMEOUT_MINUTES * 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    echoAndCollect(child.stdout, process.stdout),
    echoAndCollect(child.stderr, process.stderr),
    child.exited,
  ]);
  clearTimeout(timer);
  const output = stdout + stderr;
  if (timedOut) return { outcome: "timed_out", output };
  return { outcome: exitCode === 0 ? "passed" : "failed", output };
}
