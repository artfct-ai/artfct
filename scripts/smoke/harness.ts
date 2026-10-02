/**
 * Starts and stops the local stack under test: the mock hosts and `wrangler dev` with both
 * Workers. Children are killed on every exit path. `verifyStack` fails the run on an error line
 * from wrangler or an abnormal bridge exit.
 */
import { rmSync } from "node:fs";
import { writeDevConfig } from "../dev-config";
import { resetMockLinear } from "./linear-api";
import {
  ADMIN_TOKEN,
  GITHUB_WEBHOOK_SECRET,
  INGRESS_PORT,
  INGRESS_URL,
  IS_EXTERNAL_INGRESS,
  LINEAR_CLIENT_ID,
  LINEAR_CLIENT_SECRET,
  LINEAR_WEBHOOK_SECRET,
  MOCK_LINEAR_PORT,
  MOCK_LINEAR_URL,
  MOCK_NOTION_PORT,
  MOCK_NOTION_URL,
  MOCK_SANDBOX_PORT,
  MOCK_SANDBOX_URL,
  NOTION_TOKEN,
  PAGE_PARENT_ID,
  SLACK_SIGNING_SECRET,
} from "./config";

type ChildProcess = ReturnType<typeof Bun.spawn>;

/** A start request as the mock sandbox host recorded it. Tokens are masked. */
export type StartRecord = {
  at: string;
  sandbox_id: string;
  workflow_id: string;
  task_id: string;
  dial_url: string;
  token: string;
  harness: string;
  env: Record<string, string>;
  generation: number;
  workspace: string;
  model: string;
  repo: {
    clone_url: string;
    branch: string | null;
    author: { name: string; email: string } | null;
  } | null;
  github_token: string | null;
  files: Array<{ path: string; content: string }>;
  sleep_after_ms: number;
  startup_script: string;
  bridge_command: string;
  bridge_env: Record<string, string>;
};

/** A bridge exit as the mock sandbox host recorded it. */
export type BridgeExitRecord = {
  at: string;
  sandbox_id: string;
  generation: number;
  code: number | null;
  signal: string | null;
  /** True when the host killed the bridge itself on a destroy or a replace. */
  killed: boolean;
};

/** Everything the mock sandbox host recorded since its last reset. */
export type MockSandboxState = {
  starts: StartRecord[];
  envs: Array<{ at: string; sandbox_id: string; keys: string[] }>;
  destroys: Array<{ at: string; sandbox_id: string }>;
  exits: BridgeExitRecord[];
};

const children: ChildProcess[] = [];

/** Error lines seen in wrangler output. The first one fails the run at the next check. */
const devErrors: string[] = [];

const LOCAL_STATE_DIRS = [
  "packages/ingress/.wrangler/state",
  "packages/orchestrator/.wrangler/state",
  ".wrangler/state",
];

/** One state directory for the migration step and the dev session, so both see the same D1. */
const PERSIST_TO = ".wrangler/state";

/** Ports the stack listens on. Checked free at start and cleared at exit. */
const PORTS = [INGRESS_PORT, MOCK_SANDBOX_PORT, MOCK_LINEAR_PORT, MOCK_NOTION_PORT];

/** Exit code the bridge uses when the orchestrator asks it to restart. Not a failure. */
const RESTART_EXIT_CODE = 75;

/** Time the children get to exit after SIGTERM before the ports are cleared by force. */
const CHILD_EXIT_GRACE_MS = 5_000;

/**
 * Lines from wrangler that mean a Worker under test hit a real error. Request logs, the
 * `[wf_...]` workflow log, and the bridge chatter never match. Kept narrow on purpose.
 */
const DEV_ERROR_PATTERN =
  /✘ \[ERROR\]|\[wrangler:err(?:or)?\]|Uncaught (?:\(in (?:promise|response)\) )?[\w.]*(?:Error|Exception)\b|\bagent turn failed|\bsandbox (?:start|destroy) failed|\] slack Ev[A-Za-z0-9]+: /;

/** Lines echoed under a `dev>` prefix when the run is not verbose. */
const DEV_ECHO_PATTERN = /\[wf_/;

/** Kills every child this module spawned. Safe to call more than once. */
function killChildren(): void {
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }
}

/** Kills whatever still listens on the smoke ports. Synchronous, so the exit handler can run it. */
function killPortListeners(): void {
  const args = PORTS.flatMap((port) => ["-i", `:${port}`]);
  const result = Bun.spawnSync(["lsof", "-t", "-sTCP:LISTEN", ...args]);
  const pids = result.stdout
    .toString()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  if (pids.length) console.log(`killed leftover listeners: ${pids.join(", ")}`);
}

/** Registers handlers so no child outlives the smoke run, whatever ends it. */
export function installProcessHandlers(): void {
  process.on("exit", () => {
    killChildren();
    if (!IS_EXTERNAL_INGRESS) killPortListeners();
  });
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  process.on("uncaughtException", (error) => {
    console.error(`\nSMOKE FAILED: uncaught exception: ${error}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`\nSMOKE FAILED: unhandled rejection: ${String(reason)}`);
    process.exit(1);
  });
}

/** True when something answers HTTP on the port. */
async function isListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

/** A leftover from an earlier run would answer in place of the new stack. Refuse to start. */
async function assertPortsFree(): Promise<void> {
  for (const port of PORTS) {
    if (await isListening(port)) {
      throw new Error(
        `port ${port} is already in use. Stop the leftover process (lsof -i :${port}) and retry.`,
      );
    }
  }
}

/** Polls `url` every 300ms until it answers 2xx. Throws after `timeoutMs`. */
export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** Spawns `scripts/mock-sandbox.ts`, waits until it serves `/__state`, and clears its record. */
async function startMockSandbox(): Promise<void> {
  console.log("starting mock sandbox host");
  children.push(
    Bun.spawn(["bun", "scripts/mock-sandbox.ts", "--scripted-harness"], {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        MOCK_SANDBOX_PORT: String(MOCK_SANDBOX_PORT),
        ARTFCT_MOCK_DOCS_URL: MOCK_NOTION_URL,
      },
    }),
  );
  await waitForHealth(`${MOCK_SANDBOX_URL}/__state`, 10_000);
  await resetMockSandbox();
}

/** Spawns `scripts/mock-linear.ts`, waits until it serves `/__state`, and clears its record. */
async function startMockLinear(): Promise<void> {
  console.log("starting mock Linear API");
  children.push(
    Bun.spawn(["bun", "scripts/mock-linear.ts"], {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        MOCK_LINEAR_PORT: String(MOCK_LINEAR_PORT),
        MOCK_LINEAR_CLIENT_ID: LINEAR_CLIENT_ID,
        MOCK_LINEAR_CLIENT_SECRET: LINEAR_CLIENT_SECRET,
      },
    }),
  );
  await waitForHealth(`${MOCK_LINEAR_URL}/__state`, 10_000);
  await resetMockLinear();
}

/** Spawns `scripts/mock-notion.ts`, waits until it serves `/__state`, and clears its record. */
async function startMockNotion(): Promise<void> {
  console.log("starting mock Notion API");
  children.push(
    Bun.spawn(["bun", "scripts/mock-notion.ts"], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, MOCK_NOTION_PORT: String(MOCK_NOTION_PORT) },
    }),
  );
  await waitForHealth(`${MOCK_NOTION_URL}/__state`, 10_000);
  await resetMockNotion();
}

/** Clears every comment the mock Notion API holds. */
export async function resetMockNotion(): Promise<void> {
  const response = await fetch(`${MOCK_NOTION_URL}/__reset`, { method: "POST" });
  if (!response.ok) throw new Error(`mock notion /__reset ${response.status}`);
}

/** One comment as the mock Notion API recorded it. */
export type MockNotionComment = {
  id: string;
  page_id: string;
  created_time: string;
  text: string;
};

/** One page the mock Notion API created, with its markdown after the create and each replace. */
export type MockNotionPage = {
  id: string;
  parent_id: string;
  title: string;
  markdown_versions: string[];
};

/** Everything the mock Notion API holds. */
type MockNotionState = { comments: MockNotionComment[]; pages: MockNotionPage[] };

async function fetchMockNotionState(): Promise<MockNotionState> {
  const response = await fetch(`${MOCK_NOTION_URL}/__state`);
  if (!response.ok) throw new Error(`mock notion /__state ${response.status}`);
  return (await response.json()) as MockNotionState;
}

/** Every comment the mock Notion API holds, oldest first. */
export async function fetchMockNotionComments(): Promise<MockNotionComment[]> {
  return (await fetchMockNotionState()).comments;
}

/** Every page the mock Notion API created, oldest first. */
export async function fetchMockNotionPages(): Promise<MockNotionPage[]> {
  return (await fetchMockNotionState()).pages;
}

/** Creates a page on the mock Notion API under the smoke page parent, as a person would outside the workflow. */
export async function createMockNotionPage(
  title: string,
  markdown: string,
): Promise<{ id: string; url: string }> {
  const response = await fetch(`${MOCK_NOTION_URL}/v1/pages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parent: { page_id: PAGE_PARENT_ID },
      properties: { title: { title: [{ text: { content: title } }] } },
      markdown,
    }),
  });
  if (!response.ok) throw new Error(`mock notion create page ${response.status}`);
  const page = (await response.json()) as { id: string; url: string };
  return { id: page.id, url: page.url };
}

/** Deletes local wrangler state so each run starts from empty D1 and DO storage. */
function resetLocalState(): void {
  console.log("resetting local state");
  for (const dir of LOCAL_STATE_DIRS) rmSync(dir, { recursive: true, force: true });
}

/** Applies the orchestrator D1 migrations to the local database. */
function applyMigrations(): void {
  console.log("applying D1 migrations");
  const result = Bun.spawnSync(
    [
      "bunx",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "artfct",
      "--local",
      "-c",
      "packages/orchestrator/wrangler.test.jsonc",
      "--persist-to",
      PERSIST_TO,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) throw new Error("migrations failed");
}

/** Records error lines and echoes the interesting ones. Every line is echoed when verbose. */
function inspectDevLine(line: string, verbose: boolean): void {
  if (DEV_ERROR_PATTERN.test(line)) {
    devErrors.push(line);
    console.log(`  dev> ERROR ${line}`);
    return;
  }
  if (verbose || DEV_ECHO_PATTERN.test(line)) console.log(`  dev> ${line}`);
}

/** Reads a wrangler output stream line by line. Chunks may split lines, so a tail is kept. */
async function drainDevOutput(stream: ReadableStream<Uint8Array>, verbose: boolean): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (tail + decoder.decode(value, { stream: true })).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) inspectDevLine(line, verbose);
  }
  if (tail) inspectDevLine(tail, verbose);
}

/**
 * Starts `wrangler dev` with both Workers and waits for the ingress health check. Both configs
 * are generated under `.wrangler/smoke/` so a developer's `.dev.vars` never reaches the run.
 */
async function startWranglerDev(): Promise<void> {
  console.log("starting wrangler dev");
  const vars = { ADMIN_TOKEN, LINEAR_WEBHOOK_SECRET, GITHUB_WEBHOOK_SECRET, SLACK_SIGNING_SECRET };
  const ingressConfig = writeDevConfig("ingress", { ...vars, ADMIN_DEBUG: "true" }, "smoke");
  const orchestratorConfig = writeDevConfig(
    "orchestrator",
    {
      MOCK_SANDBOX_URL,
      PUBLIC_URL: INGRESS_URL,
      LINEAR_CLIENT_ID,
      LINEAR_CLIENT_SECRET,
      LINEAR_API_URL: MOCK_LINEAR_URL,
      NOTION_TOKEN,
      NOTION_API_URL: MOCK_NOTION_URL,
    },
    "smoke",
  );
  const verbose = Boolean(process.env.SMOKE_VERBOSE);
  const dev = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "-c",
      ingressConfig,
      "-c",
      orchestratorConfig,
      "--port",
      String(INGRESS_PORT),
      "--persist-to",
      PERSIST_TO,
      "--show-interactive-dev-session=false",
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } },
  );
  children.push(dev);
  void drainDevOutput(dev.stdout, verbose);
  void drainDevOutput(dev.stderr, verbose);
  await waitForHealth(`${INGRESS_URL}/healthz`, 60_000);
  console.log("ingress up");
}

/** Brings up the full local stack in order: free ports, mocks, clean state, migrations, dev. */
export async function startHarness(): Promise<void> {
  await assertPortsFree();
  await startMockSandbox();
  await startMockLinear();
  await startMockNotion();
  resetLocalState();
  applyMigrations();
  await startWranglerDev();
}

/**
 * Tears the stack down: bridges first, then the children, then any listener left on the
 * ports, then the local state. Called from the entry script on success and on failure.
 */
export async function stopHarness(): Promise<void> {
  if (IS_EXTERNAL_INGRESS) return;
  console.log("\nstopping the local stack");
  await resetMockSandbox().catch(() => {});
  killChildren();
  await Promise.all(
    children.map((child) => Promise.race([child.exited, Bun.sleep(CHILD_EXIT_GRACE_MS)])),
  );
  killPortListeners();
  resetLocalState();
}

/** Returns everything the mock sandbox host recorded. */
export async function fetchMockSandboxState(): Promise<MockSandboxState> {
  const response = await fetch(`${MOCK_SANDBOX_URL}/__state`);
  if (!response.ok) throw new Error(`mock sandbox /__state ${response.status}`);
  return (await response.json()) as MockSandboxState;
}

/** Kills one task's bridge as a dying container would. The orchestrator only sees the socket close. */
export async function killMockBridge(taskId: string): Promise<void> {
  const response = await fetch(`${MOCK_SANDBOX_URL}/__kill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sandbox_id: taskId }),
  });
  if (!response.ok) throw new Error(`mock sandbox /__kill ${response.status}`);
}

/**
 * Lets the mock reviewer of a pull request end its turn. It holds that turn from the start of
 * the run, so a step can read the artifact while the review still holds it back.
 */
export async function releaseMockReview(): Promise<void> {
  const response = await fetch(`${MOCK_SANDBOX_URL}/__release`, { method: "POST" });
  if (!response.ok) throw new Error(`mock sandbox /__release ${response.status}`);
}

/** Kills every bridge the mock sandbox host runs and clears its record. */
export async function resetMockSandbox(): Promise<void> {
  const response = await fetch(`${MOCK_SANDBOX_URL}/__reset`, { method: "POST" });
  if (!response.ok) throw new Error(`mock sandbox /__reset ${response.status}`);
}

/** True when the bridge ended the way the scenario allows. */
function isExpectedExit(exit: BridgeExitRecord): boolean {
  return exit.killed || exit.code === 0 || exit.code === RESTART_EXIT_CODE;
}

/**
 * Fails the run when wrangler logged an error or a bridge exited abnormally. Called after
 * every step so the failure lands next to the step that caused it.
 */
export async function verifyStack(label: string): Promise<void> {
  if (devErrors.length) {
    throw new Error(`wrangler dev logged an error during ${label}: ${devErrors[0]}`);
  }
  if (IS_EXTERNAL_INGRESS) return;
  const state = await fetchMockSandboxState();
  const abnormal = state.exits.filter((exit) => !isExpectedExit(exit));
  if (abnormal.length) {
    throw new Error(`a bridge exited abnormally during ${label}: ${JSON.stringify(abnormal)}`);
  }
  console.log(`  ok  stack healthy after ${label}`);
}
