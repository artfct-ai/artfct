import { SANDBOX_HOME, type HarnessFile } from "@artfct-ai/adapters/harness/types";
import type { Files } from "@cloudflare/sandbox";
import {
  ALL_REPOS_READ_TOKEN_FILE,
  CONTAINER_MAX_INACTIVITY_MS,
  GITHUB_TOKEN_DIR,
  WORKFLOW_REPO_TOKEN_FILE,
  bridgeCommand,
  bridgeEnv,
  githubAuthScript,
  startupScript,
  type AllReposReadToken,
  type SandboxStartSpec,
} from "./spec";

/** The container methods the sandbox Durable Object calls. Tests pass a fake. */
export type SandboxContainer = Pick<
  Container,
  "running" | "start" | "exec" | "destroy" | "setInactivityTimeout"
>;

/** The `Files` methods the sandbox Durable Object calls. Tests pass a fake. */
export type SandboxFiles = Pick<Files, "mkdir" | "writeFile" | "readFile">;

/** The storage methods the sandbox Durable Object calls. Tests pass a fake. */
export type SandboxStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

/** The container of one sandbox and the storage of its Durable Object. */
export type ContainerAndStorage = { container: SandboxContainer; storage: SandboxStorage };

/** One sandbox as its Durable Object holds it: the container, its files, and the storage. */
export type SandboxHost = ContainerAndStorage & { files: SandboxFiles };

/** Where the start writes the startup script before it runs it. */
export const STARTUP_SCRIPT = "/tmp/artfct-startup.sh";

/** Where a token refresh writes the GitHub auth script before it runs it. */
export const AUTH_SCRIPT = "/tmp/artfct-github-auth.sh";

const AUTH_TIMEOUT_MS = 60_000;

/** Where each process the sandbox runs in the background keeps its pid, logs, and exit code. */
const PROCESS_ROOT = "/tmp/artfct-processes";

/** The storage key of the sleep window the sandbox started with. */
const SLEEP_AFTER_KEY = "sleep_after_ms";

/** How often the alarm wakes the Durable Object of a sandbox that never sleeps. */
export const NEVER_SLEEP_ALARM_MS = 3_600_000;

/** The exit code of `timeout` when the command ran out of time. */
const TIMED_OUT = 124;

/**
 * Runs a command in a new session and records its pid, its output, and its exit code in the
 * directory of the process. A stale directory from an earlier start goes first.
 */
export const RUN_PROCESS = `dir=$1; shift
rm -rf "$dir" && mkdir -p "$dir"
setsid sh -c 'echo "$$" >"$0/pid.tmp" && mv "$0/pid.tmp" "$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

/** Exits 0 while the process of the directory starts or runs, and 1 once it is gone. */
export const PROCESS_ALIVE = `dir=$1
[ -d "$dir" ] && [ ! -e "$dir/exit-code" ] || exit 1
[ -e "$dir/pid" ] || exit 0
read -r pid <"$dir/pid" && kill -0 "$pid" 2>/dev/null`;

/**
 * Start the container unless it runs, write the token and harness files, run the startup script,
 * and start the bridge of the spec's generation.
 */
export async function startSandbox(host: SandboxHost, spec: SandboxStartSpec): Promise<void> {
  if (!host.container.running) host.container.start({ enableInternet: true });
  await host.storage.put(SLEEP_AFTER_KEY, spec.sleep_after_ms);
  await applySleepWindow(host, spec.sleep_after_ms);
  const env = sessionEnv(spec);
  if (spec.workflow_repo_token)
    await writeTokens(host.files, spec.workflow_repo_token, spec.all_repos_read_token);
  for (const file of spec.files) await writeHarnessFile(host.files, file);
  await host.files.writeFile(STARTUP_SCRIPT, startupScript(spec));
  const failure = await runScript(host.container, STARTUP_SCRIPT, {
    env,
    timeoutMs: spec.startup_timeout_ms,
  });
  if (failure !== null) throw new Error(`sandbox startup failed: ${failure.slice(-2000)}`);
  await host.container.exec(
    [
      "sh",
      "-c",
      RUN_PROCESS,
      "sh",
      bridgeProcessDir(spec.generation),
      "bash",
      "-c",
      bridgeCommand(spec),
    ],
    {
      cwd: spec.workspace,
      env: { ...env, ...bridgeEnv(spec) },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
}

/** Rewrite the GitHub token files and point git and gh at them again. */
export async function refreshSandboxGithubTokens(
  host: SandboxHost,
  token: string,
  read: AllReposReadToken | null,
): Promise<void> {
  await writeTokens(host.files, token, read);
  await host.files.writeFile(AUTH_SCRIPT, githubAuthScript(read));
  const failure = await runScript(host.container, AUTH_SCRIPT, {
    env: { HOME: SANDBOX_HOME },
    timeoutMs: AUTH_TIMEOUT_MS,
  });
  if (failure !== null) throw new Error(`github auth failed: ${failure.slice(-500)}`);
}

/** Whether the bridge of the generation starts or runs. A stopped container runs no bridge. */
export async function sandboxBridgeRunning(
  container: SandboxContainer,
  generation: number,
): Promise<boolean> {
  if (!container.running) return false;
  const check = await container.exec(
    ["sh", "-c", PROCESS_ALIVE, "sh", bridgeProcessDir(generation)],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return (await check.exitCode) === 0;
}

/** The text of a file in the sandbox. A missing file fails with an error that names the path. */
export async function readSandboxFile(files: SandboxFiles, path: string): Promise<string> {
  return (await files.readFile(path)).text();
}

/** Stop the container and forget its sleep window. A container that already stopped stays so. */
export async function destroySandbox(host: ContainerAndStorage): Promise<void> {
  await host.storage.deleteAlarm();
  await host.storage.delete(SLEEP_AFTER_KEY);
  if (host.container.running) await host.container.destroy();
}

/** Set the inactivity timeout again on a running container whose Durable Object restarted. */
export async function restoreSleepWindow(host: ContainerAndStorage): Promise<void> {
  const sleepAfterMs = await host.storage.get(SLEEP_AFTER_KEY);
  if (typeof sleepAfterMs === "number")
    await host.container.setInactivityTimeout(inactivityTimeoutMs(sleepAfterMs));
}

/** Alarm: wake the Durable Object of a running sandbox that never sleeps again later. */
export async function keepSleeplessSandboxAwake(host: ContainerAndStorage): Promise<void> {
  if (!host.container.running) return;
  if ((await host.storage.get(SLEEP_AFTER_KEY)) !== 0) return;
  await host.storage.setAlarm(Date.now() + NEVER_SLEEP_ALARM_MS);
}

/**
 * Give the container its inactivity timeout. A sandbox that never sleeps takes the longest
 * timeout, and an alarm that wakes its Durable Object more often than that.
 */
async function applySleepWindow(host: ContainerAndStorage, sleepAfterMs: number): Promise<void> {
  await host.container.setInactivityTimeout(inactivityTimeoutMs(sleepAfterMs));
  if (sleepAfterMs === 0) await host.storage.setAlarm(Date.now() + NEVER_SLEEP_ALARM_MS);
}

function inactivityTimeoutMs(sleepAfterMs: number): number {
  return sleepAfterMs === 0 ? CONTAINER_MAX_INACTIVITY_MS : sleepAfterMs;
}

/**
 * The env of every command the start runs. Commands see no variable of the image but `PATH`,
 * so the env names the home directory of the image's user.
 */
function sessionEnv(spec: SandboxStartSpec): Record<string, string> {
  return {
    HOME: SANDBOX_HOME,
    ...spec.env,
    ...(spec.repo ? { ARTFCT_CLONE_URL: spec.repo.clone_url } : {}),
  };
}

/** The directory of the bridge process of one generation. */
function bridgeProcessDir(generation: number): string {
  return `${PROCESS_ROOT}/artfct-bridge-${generation}`;
}

/** Run a script with bash under a time limit. Resolves with the reason it failed, or null. */
async function runScript(
  container: SandboxContainer,
  path: string,
  options: { env: Record<string, string>; timeoutMs: number },
): Promise<string | null> {
  const seconds = Math.ceil(options.timeoutMs / 1000);
  const script = await container.exec(["timeout", "--kill-after=5", `${seconds}`, "bash", path], {
    env: options.env,
    stdout: "ignore",
  });
  const output = await script.output();
  if (output.exitCode === 0) return null;
  if (output.exitCode === TIMED_OUT) return `timed out after ${seconds}s`;
  return new TextDecoder().decode(output.stderr);
}

/** Write the GitHub token files. The startup and auth scripts restrict their mode. */
async function writeTokens(
  files: SandboxFiles,
  token: string,
  read: AllReposReadToken | null,
): Promise<void> {
  await files.mkdir(GITHUB_TOKEN_DIR, { recursive: true });
  await files.writeFile(WORKFLOW_REPO_TOKEN_FILE, token);
  if (read) await files.writeFile(ALL_REPOS_READ_TOKEN_FILE, read.token);
}

/** Write one file the harness reads, creating its directory. */
async function writeHarnessFile(files: SandboxFiles, file: HarnessFile): Promise<void> {
  await files.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), { recursive: true });
  await files.writeFile(file.path, file.content);
}
