import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  GITHUB_READ_TOKEN_FILE,
  GITHUB_TOKEN_FILE,
  startupScript,
  type SandboxStartSpec,
} from "../../src/sandbox/spec";

/** The image a local run starts. Build it with `bun run sandbox:build`. */
export const LOCAL_IMAGE = "artfct-sandbox:local";

const STARTUP_SCRIPT = "/tmp/artfct-startup.sh";

/** The harness process of a local run. Its stderr goes to the terminal. */
export type HarnessChild = ChildProcessByStdio<Writable, Readable, null>;

/** A started container with the files, env, and checkout of one start spec. */
export type LocalContainer = {
  id: string;
  /** The harness process, speaking ACP on stdin and stdout. */
  spawnHarness(command: string[], env: Record<string, string>): HarnessChild;
  destroy(): Promise<void>;
};

/**
 * Start a container and prepare it in the order `CloudflareSandboxProvider.start` does: env,
 * token file, harness files, then the startup script.
 */
export async function startLocalContainer(spec: SandboxStartSpec): Promise<LocalContainer> {
  const env = { ...spec.env, ...(spec.repo ? { ARTFCT_CLONE_URL: spec.repo.clone_url } : {}) };
  const id = await runContainer(env);
  const container: LocalContainer = {
    id,
    spawnHarness: (command, harnessEnv) =>
      spawn(
        "docker",
        ["exec", "-i", "-w", spec.workspace, ...envNames(harnessEnv), id, ...command],
        { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...harnessEnv } },
      ),
    destroy: async () => {
      await docker(["rm", "-f", id]);
    },
  };
  try {
    if (spec.github_token) await writeContainerFile(id, GITHUB_TOKEN_FILE, spec.github_token);
    if (spec.github_read) {
      await writeContainerFile(id, GITHUB_READ_TOKEN_FILE, spec.github_read.token);
    }
    for (const file of spec.files) await writeContainerFile(id, file.path, file.content);
    await writeContainerFile(id, STARTUP_SCRIPT, startupScript(spec));
    await docker(["exec", id, "bash", STARTUP_SCRIPT]);
  } catch (error) {
    await container.destroy();
    throw error;
  }
  return container;
}

/** Docker reads each value from its own env, so no secret shows in a process list. */
function envNames(env: Record<string, string>): string[] {
  return Object.keys(env).flatMap((name) => ["-e", name]);
}

async function runContainer(env: Record<string, string>): Promise<string> {
  const args = ["run", "--detach", ...envNames(env), "--entrypoint", "sleep", LOCAL_IMAGE];
  return (await docker([...args, "infinity"], { env })).trim();
}

async function writeContainerFile(id: string, path: string, content: string): Promise<void> {
  const write = 'mkdir -p "$(dirname "$1")" && cat > "$1"';
  await docker(["exec", "-i", id, "sh", "-c", write, "sh", path], { stdin: content });
}

function docker(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`docker ${args[0]} failed: ${stderr.slice(-2000)}`));
    });
    child.stdin.end(options.stdin ?? "");
  });
}
