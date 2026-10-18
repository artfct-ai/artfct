import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/** A property test file and the runs each property in it takes per full e2e run. */
export type PropertyFile = { title: string; path: string; runner: string[]; e2eRuns: number };

/** The outcome of one property file run, with everything it printed. */
export type PropertyRun = { outcome: "passed" | "failed" | "timed_out"; output: string };

/** The property test files the CI property and replay jobs and the nightly mutant run use. */
export const PROPERTY_FILES = {
  chat_acknowledgement: {
    title: "chat acknowledgement spec replay",
    path: "src/router/chat-acknowledgement-replay.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
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
  harness_session: {
    title: "harness session spec replay",
    path: "src/workflow/task/harness/harness-session-replay.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
  agent_turns: {
    title: "agent turns spec replay",
    path: "src/agent/turn/agent-turns-replay.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 300,
  },
  feedback_routing: {
    title: "feedback routing spec replay",
    path: "src/workflow/refiner/feedback-routing-replay.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
} satisfies Record<string, PropertyFile>;

/** A property file run past this is a hang, reported with its seed. */
export const PROPERTY_FILE_TIMEOUT_MINUTES = 20;

const ORCHESTRATOR_DIR = join(import.meta.dirname, "../..");

/** The runs each property of a file takes in an e2e run, divided by `PROPERTY_RUNS_DIVISOR` for a light run. */
function e2eRunCount(file: PropertyFile): number {
  return Math.ceil(file.e2eRuns / Number(process.env.PROPERTY_RUNS_DIVISOR ?? 1));
}

/** The command, run from the orchestrator package, that repeats an e2e run exactly. */
export function propertyReplayCommand(file: PropertyFile, seed: number): string {
  return `PROPERTY_SEED=${seed} PROPERTY_RUNS=${e2eRunCount(file)} ${[...file.runner, file.path].join(" ")}`;
}

/** One process of a property file run: the test runner arguments it adds, and the name on its output lines. */
export type PropertyPart = { label: string; args: string[] };

/**
 * The processes a property file runs in: one per spec setup of a replay file, or one for the
 * whole file. The process of the first setup also takes every test outside a setup.
 */
export function propertyParts(file: PropertyFile, setups: string[]): PropertyPart[] {
  const [first, ...others] = setups;
  if (!first || !others.length) return [{ label: file.title, args: [] }];
  return [
    { label: first, args: ["-t", `^(?!.* on (${others.join("|")})$)`] },
    ...others.map((setup) => ({ label: setup, args: ["-t", ` on ${setup}$`] })),
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

async function runPart(options: {
  file: PropertyFile;
  seed: number;
  part: PropertyPart;
  prefix: string;
  children: Set<Subprocess>;
}): Promise<{ exitCode: number; output: string }> {
  const { file, seed, part, prefix, children } = options;
  const child = Bun.spawn([...file.runner, file.path, ...part.args], {
    cwd: ORCHESTRATOR_DIR,
    env: {
      ...process.env,
      PROPERTY_SEED: String(seed),
      PROPERTY_RUNS: String(e2eRunCount(file)),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  const [stdout, stderr, exitCode] = await Promise.all([
    echoAndCollect(child.stdout, process.stdout, prefix),
    echoAndCollect(child.stderr, process.stderr, prefix),
    child.exited,
  ]);
  children.delete(child);
  return { exitCode, output: stdout + stderr };
}

/**
 * Runs one property file at its e2e run count on a seed, and echoes its output as it runs. A spec
 * replay runs each setup in its own process, as many at once as the machine has cores.
 */
export async function runPropertyFile(file: PropertyFile, seed: number): Promise<PropertyRun> {
  const parts = propertyParts(file, replayedSetups(file));
  const children = new Set<Subprocess>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const child of children) child.kill();
  }, PROPERTY_FILE_TIMEOUT_MINUTES * 60_000);
  const outputs: string[] = [];
  let failed = false;
  const waiting = [...parts.entries()];
  const runWaitingParts = async () => {
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      if (timedOut) return;
      const [index, part] = next;
      const prefix = parts.length > 1 ? `[${part.label}] ` : "";
      const run = await runPart({ file, seed, part, prefix, children });
      outputs[index] = run.output;
      if (run.exitCode !== 0) failed = true;
    }
  };
  const processes = Math.min(availableParallelism(), parts.length);
  await Promise.all(Array.from({ length: processes }, runWaitingParts));
  clearTimeout(timer);
  const output = outputs.join("");
  if (timedOut) return { outcome: "timed_out", output };
  return { outcome: failed ? "failed" : "passed", output };
}
