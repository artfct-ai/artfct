import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/** A property test file, the package directory it runs from, and the runs each property in it takes per full e2e run. */
export type PropertyFile = {
  title: string;
  packageDir: string;
  path: string;
  runner: string[];
  e2eRuns: number;
};

/** The outcome of one property file run, with everything it printed. */
export type PropertyRun = { outcome: "passed" | "failed" | "timed_out"; output: string };

/** The spec replay files, which the `spec:replay` task, the CI replay jobs and the mutant run use. */
export const SPEC_REPLAY_FILES = {
  chat_acknowledgement: {
    title: "chat acknowledgement spec replay",
    packageDir: "orchestrator",
    path: "./src/router/chat-acknowledgement.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
  router_bindings: {
    title: "router bindings spec replay",
    packageDir: "orchestrator",
    path: "./src/router/router-bindings.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
  review_loop: {
    title: "review loop spec replay",
    packageDir: "orchestrator",
    path: "./src/workflow/review-loop.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 300,
  },
  workflow_lifecycle: {
    title: "workflow lifecycle spec replay",
    packageDir: "orchestrator",
    path: "./src/workflow/workflow-lifecycle.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 1000,
  },
  harness_session: {
    title: "harness session spec replay",
    packageDir: "orchestrator",
    path: "./src/workflow/task/harness/harness-session.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
  agent_turns: {
    title: "agent turns spec replay",
    packageDir: "orchestrator",
    path: "./src/agent/turn/agent-turns.replay.medium.ts",
    runner: ["bunx", "vitest", "run", "--config", "vitest.replay.config.ts"],
    e2eRuns: 300,
  },
  session_routing: {
    title: "session routing spec replay",
    packageDir: "orchestrator",
    path: "./src/workflow/session-routing.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
  feedback_routing: {
    title: "feedback routing spec replay",
    packageDir: "orchestrator",
    path: "./src/workflow/refiner/feedback-routing.replay.ts",
    runner: ["bun", "test"],
    e2eRuns: 3000,
  },
} satisfies Record<string, PropertyFile>;

/** The property test files that check logic the Quint specs do not model, for the main and nightly property jobs. */
export const STANDALONE_PROPERTY_FILES: PropertyFile[] = [
  {
    title: "slack inbound mapper properties",
    packageDir: "adapters",
    path: "./src/chat/slack/inbound-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "slack text properties",
    packageDir: "adapters",
    path: "./src/chat/slack/text-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "github inbound mapper properties",
    packageDir: "adapters",
    path: "./src/code/github/inbound-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "github code properties",
    packageDir: "adapters",
    path: "./src/code/github/code-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "linear inbound mapper properties",
    packageDir: "adapters",
    path: "./src/tracker/linear/inbound-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "notion inbound mapper properties",
    packageDir: "adapters",
    path: "./src/documents/notion/inbound-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "linear held comments properties",
    packageDir: "adapters",
    path: "./src/documents/linear/held-comments.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 200_000,
  },
  {
    title: "notion held comments properties",
    packageDir: "adapters",
    path: "./src/documents/notion/held-comments.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 200_000,
  },
  {
    title: "notion text properties",
    packageDir: "adapters",
    path: "./src/documents/notion/text-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "linear document write property",
    packageDir: "adapters",
    path: "./src/documents/linear/write-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "page text update properties",
    packageDir: "adapters",
    path: "./src/documents/page-text-update.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "webhook signature properties",
    packageDir: "ingress",
    path: "./src/routes/webhook-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "bridge line reader properties",
    packageDir: "bridge",
    path: "./src/line-reader-invariants.test.ts",
    runner: ["bun", "test"],
    e2eRuns: 100_000,
  },
  {
    title: "condensed tool result property",
    packageDir: "orchestrator",
    path: "./src/agent/tools/condensed.property.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 20_000,
  },
  {
    title: "person upserts property",
    packageDir: "orchestrator",
    path: "./src/db/persons.property.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 3_000,
  },
  {
    title: "tracker install token refresh property",
    packageDir: "orchestrator",
    path: "./src/oauth/token.property.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 5_000,
  },
  {
    title: "access rules property",
    packageDir: "orchestrator",
    path: "./src/router/identity.property.test.medium.ts",
    runner: ["bunx", "vitest", "run"],
    e2eRuns: 50_000,
  },
];

/** A property file run past this is a hang, reported with its seed. */
export const PROPERTY_FILE_TIMEOUT_MINUTES = 20;

const ORCHESTRATOR_DIR = join(import.meta.dirname, "../..");
const PACKAGES_DIR = join(ORCHESTRATOR_DIR, "..");

/** The runs each property of a file takes in an e2e run, divided by `PROPERTY_RUNS_DIVISOR` for a light run. */
function e2eRunCount(file: PropertyFile): number {
  return Math.ceil(file.e2eRuns / Number(process.env.PROPERTY_RUNS_DIVISOR ?? 1));
}

/** The command, run from the file's package directory, that repeats an e2e run exactly. */
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
  vars: Record<string, string>;
  part: PropertyPart;
  prefix: string;
  children: Set<Subprocess>;
}): Promise<{ exitCode: number; output: string }> {
  const { file, vars, part, prefix, children } = options;
  const child = Bun.spawn([...file.runner, file.path, ...part.args], {
    cwd: join(PACKAGES_DIR, file.packageDir),
    env: {
      ...process.env,
      ...vars,
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

/** Runs one property file at its e2e run count on a seed, and echoes its output as it runs. */
export function runPropertyFile(file: PropertyFile, seed: number): Promise<PropertyRun> {
  return runPropertyParts(file, {
    PROPERTY_SEED: String(seed),
    PROPERTY_RUNS: String(e2eRunCount(file)),
  });
}

/**
 * Runs one property file with the property variables `vars`, and echoes its output as it runs. A
 * spec replay runs each setup in its own process, as many at once as the machine has cores.
 */
export async function runPropertyParts(
  file: PropertyFile,
  vars: Record<string, string>,
): Promise<PropertyRun> {
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
      const run = await runPart({ file, vars, part, prefix, children });
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
