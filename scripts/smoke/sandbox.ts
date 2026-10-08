/**
 * Assertions on the mock sandbox record: start specs, destroys, and bridge exits.
 * Every helper is a no-op with a log line when the smoke targets an external stack.
 */
import { waitUntil } from "./admin";
import { assert, assertEqual } from "./assert";
import { INGRESS_URL, IS_EXTERNAL_INGRESS, NOTION_TOKEN, REPO_FULL_NAME } from "./config";
import { STAGE_HARNESS, STAGE_MODEL } from "../../packages/orchestrator/test/smoke-config";
import { fetchMockSandboxState, type BridgeExitRecord, type StartRecord } from "./harness";

/** Workspace path the orchestrator clones into. Mirrors `WORKSPACE` in provisioning.ts. */
const WORKSPACE = "/workspace/repo";

/** Mock harness home-level instructions file. Mirrors `MockHarness`. */
const INSTRUCTIONS_FILE = "/home/node/.config/artfct-mock/AGENTS.md";

/** Mock harness skills directory. Mirrors `MockHarness`. */
const SKILLS_DIR = "/home/node/.config/artfct-mock/skills";

/** Prints why a sandbox check is skipped. */
function skip(label: string): void {
  console.log(`  --  ${label}: skipped (INGRESS_URL is external, no mock sandbox record)`);
}

/** Number of starts recorded so far, for one task or for every task. Zero when external. */
export async function startCountBaseline(taskId?: string): Promise<number> {
  if (IS_EXTERNAL_INGRESS) return 0;
  return countStarts(taskId);
}

/**
 * Asserts that exactly `expected` starts happened since `baseline`. With `taskId` only that
 * task's starts count, so a code review task starting alongside cannot change the number.
 */
export async function assertStartsSince(
  baseline: number,
  expected: number,
  label: string,
  taskId?: string,
): Promise<void> {
  if (IS_EXTERNAL_INGRESS) return skip(label);
  assertEqual((await countStarts(taskId)) - baseline, expected, label);
}

/** Starts recorded by the mock sandbox host, for one task or for every task. */
async function countStarts(taskId?: string): Promise<number> {
  const { starts } = await fetchMockSandboxState();
  return taskId ? starts.filter((start) => start.sandbox_id === taskId).length : starts.length;
}

/** The latest start record for a task. Null when the stack is external. */
export async function latestStart(taskId: string): Promise<StartRecord | null> {
  if (IS_EXTERNAL_INGRESS) return null;
  const state = await fetchMockSandboxState();
  return state.starts.filter((start) => start.sandbox_id === taskId).at(-1) ?? null;
}

/**
 * Checks the start spec the orchestrator posted for a task: identity, harness, model,
 * workspace, repository, dial URL, env, and the bridge command
 * line. Only the PR stage creates a task branch.
 */
export async function assertStartSpec(options: {
  workflowId: string;
  taskId: string;
  stage: string;
  branch: string | null;
  generation: number;
}): Promise<void> {
  const { workflowId, taskId, stage, branch, generation } = options;
  const start = await latestStart(taskId);
  if (!start) return skip("start spec");
  const dialUrl = `${INGRESS_URL.replace(/^http/, "ws")}/bridge/${workflowId}/${taskId}`;

  assertEqual(start.workflow_id, workflowId, "start spec workflow_id");
  assertEqual(start.task_id, taskId, "start spec task_id");
  assertEqual(start.generation, generation, "start spec generation");
  assertEqual(start.harness, STAGE_HARNESS, "start spec harness");
  assertEqual(start.model, STAGE_MODEL, "start spec model");
  assertEqual(start.workspace, WORKSPACE, "start spec workspace");
  assertEqual(start.dial_url, dialUrl, "start spec dial_url");
  assertEqual(start.token, "***", "start spec token is masked in the record");
  assertEqual(start.bridge_env, { ARTFCT_TOKEN: "***" }, "start spec bridge_env carries the token");
  assertEqual(
    start.repo,
    { clone_url: `https://github.com/${REPO_FULL_NAME}.git`, branch, author: null },
    "start spec repo",
  );
  assertEqual(start.github_token, null, "start spec github_token (no GitHub App in smoke)");
  assertEqual(start.github_read, null, "start spec github_read (no GitHub App in smoke)");
  assertEqual(
    start.files[0]?.path,
    INSTRUCTIONS_FILE,
    "start spec files open with the home-level instructions",
  );
  assert(start.files[0]?.content.trim(), "home-level instructions carry the writing rules");
  const skillPaths = start.files.slice(1).map((file) => file.path);
  assert(
    skillPaths.length > 0 && skillPaths.every((path) => path.startsWith(`${SKILLS_DIR}/`)),
    "start spec installs the task's skill files under the harness skills directory",
    skillPaths.join(", "),
  );
  assert(
    skillPaths.some((path) => path.endsWith("/SKILL.md")),
    "start spec installs a SKILL.md for the skill the task runs",
    skillPaths.join(", "),
  );

  const env = start.env;
  assertEqual(env.ARTFCT_TASK_ID, taskId, "env ARTFCT_TASK_ID");
  assertEqual(env.ARTFCT_WORKFLOW_ID, workflowId, "env ARTFCT_WORKFLOW_ID");
  assertEqual(env.ARTFCT_STAGE, stage, "env ARTFCT_STAGE");
  assertEqual(env.ARTFCT_REPO, REPO_FULL_NAME, "env ARTFCT_REPO");
  assertEqual(
    env.ARTFCT_MOCK_REPO_URL,
    `https://github.com/${REPO_FULL_NAME}`,
    "env ARTFCT_MOCK_REPO_URL",
  );
  assertEqual(env.GIT_TERMINAL_PROMPT, "0", "env GIT_TERMINAL_PROMPT");
  assertEqual(
    env.NOTION_API_TOKEN,
    branch ? undefined : NOTION_TOKEN,
    "env carries the Notion CLI token on a page stage alone",
  );
  assertEqual(env.ANTHROPIC_BASE_URL, undefined, "env has no ANTHROPIC_BASE_URL without a gateway");
  assertEqual(env.OPENAI_BASE_URL, undefined, "env has no OPENAI_BASE_URL without a gateway");
  assert(!("GITHUB_TOKEN" in env), "env carries no GITHUB_TOKEN", Object.keys(env));
  assert(
    !("CLAUDE_CODE_OAUTH_TOKEN" in env),
    "env carries no CLAUDE_CODE_OAUTH_TOKEN",
    Object.keys(env),
  );

  assertEqual(
    start.bridge_command,
    `artfct-bridge --harness '${STAGE_HARNESS}' --dial '${dialUrl}' --cwd '${WORKSPACE}' --model '${STAGE_MODEL}' --generation ${generation}`,
    "start spec bridge_command",
  );
  const clones = start.startup_script.includes(
    `git clone --filter=blob:none "$ARTFCT_CLONE_URL" '${WORKSPACE}.clone'`,
  );
  assert(clones, "startup script clones the repository", start.startup_script);
  const createsBranch = start.startup_script.includes("git checkout -b ");
  if (!branch) {
    assert(!createsBranch, "document stage stays on the default branch", start.startup_script);
    return;
  }
  assert(
    start.startup_script.includes(`git checkout -b '${branch}'`),
    "startup script creates the task branch",
    start.startup_script,
  );
}

/**
 * Waits until the orchestrator posted `/destroy` for the task's latest sandbox and that bridge
 * has exited, then returns the exit record. The bridge may exit on its own or be killed by the
 * host. A restarted task has an earlier generation's destroy and exit, which do not count.
 */
export async function waitForSandboxDestroyed(
  taskId: string,
  label: string,
): Promise<BridgeExitRecord | null> {
  if (IS_EXTERNAL_INGRESS) {
    skip(label);
    return null;
  }
  return waitUntil({ label, timeoutMs: 10_000 }, async () => {
    const state = await fetchMockSandboxState();
    const started = state.starts.filter((start) => start.sandbox_id === taskId).at(-1);
    if (!started) return null;
    const destroyed = state.destroys.some(
      (destroy) => destroy.sandbox_id === taskId && destroy.at > started.at,
    );
    const exit = state.exits.find(
      (entry) => entry.sandbox_id === taskId && entry.generation === started.generation,
    );
    return destroyed && exit ? exit : null;
  });
}
