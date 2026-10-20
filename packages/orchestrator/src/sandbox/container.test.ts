import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSandboxHost, type FakeExecResult } from "../../test/fake-container";
import {
  AUTH_SCRIPT,
  NEVER_SLEEP_ALARM_MS,
  PROCESS_ALIVE,
  RUN_PROCESS,
  STARTUP_SCRIPT,
  destroySandbox,
  keepSleeplessSandboxAwake,
  readSandboxFile,
  refreshSandboxGithubTokens,
  restoreSleepWindow,
  sandboxBridgeRunning,
  startSandbox,
} from "./container";
import {
  ALL_REPOS_READ_TOKEN_FILE,
  CONTAINER_MAX_INACTIVITY_MS,
  GITHUB_TOKEN_DIR,
  WORKFLOW_REPO_TOKEN_FILE,
  bridgeCommand,
  githubAuthScript,
  startupScript,
  type SandboxStartSpec,
} from "./spec";

const spec: SandboxStartSpec = {
  sandbox_id: "wf_x.1",
  size: "large",
  workflow_id: "wf_x",
  task_id: "wf_x.1",
  harness: "claude-code",
  model: "claude-sonnet-5",
  dial_url: "wss://ao.example.com/bridge/wf_x/wf_x.1",
  token: "tok",
  generation: 2,
  workspace: "/workspace/repo",
  repo: { clone_url: "https://github.com/acme/app.git", branch: "artfct/wf_x-1-fix", author: null },
  workflow_repo_token: "ghs_1",
  all_repos_read_token: null,
  env: { ARTFCT_TASK_ID: "wf_x.1" },
  files: [],
  setup_commands: [],
  sleep_after_ms: 1_800_000,
  startup_timeout_ms: 2_700_000,
};

const READ = { token: "ghs_read", workflow_repo: "acme/app" };

const STARTUP_ARGV = ["timeout", "--kill-after=5", "2700", "bash", STARTUP_SCRIPT];
const AUTH_ARGV = ["timeout", "--kill-after=5", "60", "bash", AUTH_SCRIPT];

function answering(failures: Record<string, FakeExecResult>): (argv: string[]) => FakeExecResult {
  return (argv) => failures[argv.join(" ")] ?? { exitCode: 0 };
}

function failureMessage(call: Promise<unknown>): Promise<string | null> {
  return call.then(
    () => null,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );
}

describe("startSandbox", () => {
  describe("on a task with a repo and a token", () => {
    const host = fakeSandboxHost();

    beforeAll(async () => {
      await startSandbox(host, spec);
    });

    it("starts the container with Internet access", () => {
      expect(host.container.starts).toEqual([{ enableInternet: true }]);
    });

    it("gives the container the sleep window as its inactivity timeout", () => {
      expect(host.container.inactivityTimeouts).toEqual([1_800_000]);
    });

    it("sets no alarm", () => {
      expect(host.storage.alarm).toBeNull();
    });

    it("makes the token directory", () => {
      expect(host.files.dirs).toEqual([GITHUB_TOKEN_DIR]);
    });

    it("writes the token file and no all-repos read token file", () => {
      expect(host.files.files.get(WORKFLOW_REPO_TOKEN_FILE)).toBe("ghs_1");
      expect(host.files.files.has(ALL_REPOS_READ_TOKEN_FILE)).toBe(false);
    });

    it("writes the startup script", () => {
      expect(host.files.files.get(STARTUP_SCRIPT)).toBe(startupScript(spec));
    });

    it("runs the startup script within the spec's time limit, with the task env and clone url", () => {
      expect(host.container.execs[0]).toEqual({
        argv: STARTUP_ARGV,
        options: {
          env: {
            HOME: "/home/node",
            ARTFCT_TASK_ID: "wf_x.1",
            ARTFCT_CLONE_URL: "https://github.com/acme/app.git",
          },
          stdout: "ignore",
        },
      });
    });

    it("starts the bridge of the generation in the workspace, with its token in the env", () => {
      expect(host.container.execs[1]).toEqual({
        argv: [
          "sh",
          "-c",
          RUN_PROCESS,
          "sh",
          "/tmp/artfct-processes/artfct-bridge-2",
          "bash",
          "-c",
          bridgeCommand(spec),
        ],
        options: {
          cwd: "/workspace/repo",
          env: {
            HOME: "/home/node",
            ARTFCT_TASK_ID: "wf_x.1",
            ARTFCT_CLONE_URL: "https://github.com/acme/app.git",
            ARTFCT_TOKEN: "tok",
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      });
    });

    it("runs nothing else", () => {
      expect(host.container.execs).toHaveLength(2);
    });
  });

  describe("on a container that already runs", () => {
    it("does not start it again", async () => {
      const host = fakeSandboxHost();
      host.container.running = true;
      await startSandbox(host, { ...spec, generation: 3 });
      expect(host.container.starts).toEqual([]);
    });
  });

  describe("on a task that may read every repository", () => {
    it("writes both token files before the startup script", async () => {
      const host = fakeSandboxHost();
      await startSandbox(host, { ...spec, all_repos_read_token: READ });
      expect([...host.files.files.entries()]).toEqual([
        [WORKFLOW_REPO_TOKEN_FILE, "ghs_1"],
        [ALL_REPOS_READ_TOKEN_FILE, "ghs_read"],
        [STARTUP_SCRIPT, startupScript({ ...spec, all_repos_read_token: READ })],
      ]);
    });
  });

  describe("on a task with harness files", () => {
    const file = { path: "/home/node/.config/opencode/opencode.json", content: "{}" };
    const host = fakeSandboxHost();

    beforeAll(async () => {
      await startSandbox(host, { ...spec, workflow_repo_token: null, files: [file] });
    });

    it("makes the directory of the file", () => {
      expect(host.files.dirs).toEqual(["/home/node/.config/opencode"]);
    });

    it("writes the file before the startup script", () => {
      expect([...host.files.files.entries()]).toEqual([
        [file.path, "{}"],
        [STARTUP_SCRIPT, startupScript({ ...spec, workflow_repo_token: null, files: [file] })],
      ]);
    });
  });

  describe("on a task with no repo, no token, and a sandbox that never sleeps", () => {
    const host = fakeSandboxHost();
    let before: number;

    beforeAll(async () => {
      before = Date.now();
      await startSandbox(host, {
        ...spec,
        repo: null,
        workflow_repo_token: null,
        sleep_after_ms: 0,
      });
    });

    it("gives the container the longest inactivity timeout", () => {
      expect(host.container.inactivityTimeouts).toEqual([CONTAINER_MAX_INACTIVITY_MS]);
    });

    it("sets an alarm that wakes the Durable Object within the timeout", () => {
      expect(host.storage.alarm).toBeGreaterThanOrEqual(before + NEVER_SLEEP_ALARM_MS);
      expect(NEVER_SLEEP_ALARM_MS).toBeLessThan(CONTAINER_MAX_INACTIVITY_MS);
    });

    it("sets no clone url", () => {
      expect(host.container.execs[0]?.options.env).toEqual({
        HOME: "/home/node",
        ARTFCT_TASK_ID: "wf_x.1",
      });
    });

    it("makes no directory and writes the startup script alone", () => {
      expect(host.files.dirs).toEqual([]);
      expect([...host.files.files.keys()]).toEqual([STARTUP_SCRIPT]);
    });

    it("starts the bridge", () => {
      expect(host.container.execs).toHaveLength(2);
    });
  });

  describe("when the startup script fails", () => {
    const host = fakeSandboxHost(
      answering({ [STARTUP_ARGV.join(" ")]: { exitCode: 1, stderr: "fatal: clone failed" } }),
    );
    let failure: string | null;

    beforeAll(async () => {
      failure = await failureMessage(startSandbox(host, spec));
    });

    it("fails with the stderr of the script", () => {
      expect(failure).toBe("sandbox startup failed: fatal: clone failed");
    });

    it("never starts the bridge", () => {
      expect(host.container.execs).toHaveLength(1);
    });
  });

  describe("when the startup script runs out of time", () => {
    it("fails with the time limit", async () => {
      const host = fakeSandboxHost(answering({ [STARTUP_ARGV.join(" ")]: { exitCode: 124 } }));
      expect(await failureMessage(startSandbox(host, spec))).toBe(
        "sandbox startup failed: timed out after 2700s",
      );
    });
  });

  describe("after destroy", () => {
    const host = fakeSandboxHost();

    beforeAll(async () => {
      await startSandbox(host, spec);
      await destroySandbox(host);
      host.files.files.clear();
      await startSandbox(host, spec);
    });

    it("destroys the first container once and starts a second", () => {
      expect(host.container.destroyed).toBe(1);
      expect(host.container.starts).toHaveLength(2);
    });

    it("writes the token file again, which the destroyed container took with it", () => {
      expect(host.files.files.get(WORKFLOW_REPO_TOKEN_FILE)).toBe("ghs_1");
    });

    it("runs the startup script again, so an empty workspace is cloned, and starts a bridge", () => {
      expect(host.container.execs.map((exec) => exec.argv[0])).toEqual([
        "timeout",
        "sh",
        "timeout",
        "sh",
      ]);
      expect(host.files.files.get(STARTUP_SCRIPT)).toContain("git clone");
    });
  });
});

describe("refreshSandboxGithubTokens", () => {
  describe("without an all-repos read token", () => {
    const host = fakeSandboxHost();

    beforeAll(async () => {
      host.container.running = true;
      await refreshSandboxGithubTokens(host, "ghs_2", null);
    });

    it("rewrites the token file", () => {
      expect(host.files.files.get(WORKFLOW_REPO_TOKEN_FILE)).toBe("ghs_2");
    });

    it("writes the auth script", () => {
      expect(host.files.files.get(AUTH_SCRIPT)).toBe(githubAuthScript(null));
    });

    it("runs the auth script within a minute, in the home directory of the image's user", () => {
      expect(host.container.execs).toEqual([
        { argv: AUTH_ARGV, options: { env: { HOME: "/home/node" }, stdout: "ignore" } },
      ]);
    });
  });

  describe("with an all-repos read token", () => {
    const fresh = { ...READ, token: "ghs_read_2" };
    const host = fakeSandboxHost();

    beforeAll(async () => {
      host.container.running = true;
      await refreshSandboxGithubTokens(host, "ghs_2", fresh);
    });

    it("rewrites both token files", () => {
      expect(host.files.files.get(WORKFLOW_REPO_TOKEN_FILE)).toBe("ghs_2");
      expect(host.files.files.get(ALL_REPOS_READ_TOKEN_FILE)).toBe("ghs_read_2");
    });

    it("writes the auth script that hands each repository its token", () => {
      expect(host.files.files.get(AUTH_SCRIPT)).toBe(githubAuthScript(fresh));
    });
  });

  describe("when the auth script fails", () => {
    it("reports the stderr of the script", async () => {
      const host = fakeSandboxHost(
        answering({ [AUTH_ARGV.join(" ")]: { exitCode: 1, stderr: "gh: bad token" } }),
      );
      host.container.running = true;
      expect(await failureMessage(refreshSandboxGithubTokens(host, "ghs_2", null))).toBe(
        "github auth failed: gh: bad token",
      );
    });
  });
});

describe("sandboxBridgeRunning", () => {
  const PROBE = ["sh", "-c", PROCESS_ALIVE, "sh", "/tmp/artfct-processes/artfct-bridge-3"];

  it("asks the container about the bridge of the generation", async () => {
    const host = fakeSandboxHost();
    host.container.running = true;
    await sandboxBridgeRunning(host.container, 3);
    expect(host.container.execs.map((exec) => exec.argv)).toEqual([PROBE]);
  });

  it("answers true while the probe finds the bridge", async () => {
    const host = fakeSandboxHost();
    host.container.running = true;
    expect(await sandboxBridgeRunning(host.container, 3)).toBe(true);
  });

  it("answers false once the probe finds the bridge gone", async () => {
    const host = fakeSandboxHost(answering({ [PROBE.join(" ")]: { exitCode: 1 } }));
    host.container.running = true;
    expect(await sandboxBridgeRunning(host.container, 3)).toBe(false);
  });

  it("answers false without a command when the container stopped", async () => {
    const host = fakeSandboxHost();
    expect(await sandboxBridgeRunning(host.container, 3)).toBe(false);
    expect(host.container.execs).toEqual([]);
  });
});

describe("readSandboxFile", () => {
  const host = fakeSandboxHost();

  beforeEach(() => {
    host.files.files.set("/workspace/research.json", '{"findings":[]}');
  });

  it("reads the text of the file", async () => {
    expect(await readSandboxFile(host.files, "/workspace/research.json")).toBe('{"findings":[]}');
  });

  it("fails with an error that names a missing file", async () => {
    expect(await failureMessage(readSandboxFile(host.files, "/workspace/missing.json"))).toContain(
      "/workspace/missing.json",
    );
  });
});

describe("destroySandbox", () => {
  it("stops a running container and forgets its sleep window and alarm", async () => {
    const host = fakeSandboxHost();
    await startSandbox(host, { ...spec, sleep_after_ms: 0 });
    await destroySandbox(host);
    expect(host.container.destroyed).toBe(1);
    expect(host.container.running).toBe(false);
    expect(host.storage.values.size).toBe(0);
    expect(host.storage.alarm).toBeNull();
  });

  it("leaves a stopped container alone", async () => {
    const host = fakeSandboxHost();
    await destroySandbox(host);
    expect(host.container.destroyed).toBe(0);
  });
});

describe("restoreSleepWindow", () => {
  it("gives a restarted Durable Object's container the sleep window it started with", async () => {
    const host = fakeSandboxHost();
    await startSandbox(host, spec);
    await restoreSleepWindow(host);
    expect(host.container.inactivityTimeouts).toEqual([1_800_000, 1_800_000]);
  });

  it("gives a sandbox that never sleeps the longest timeout", async () => {
    const host = fakeSandboxHost();
    await startSandbox(host, { ...spec, sleep_after_ms: 0 });
    await restoreSleepWindow(host);
    expect(host.container.inactivityTimeouts).toEqual([
      CONTAINER_MAX_INACTIVITY_MS,
      CONTAINER_MAX_INACTIVITY_MS,
    ]);
  });

  it("sets no timeout on a sandbox that never started", async () => {
    const host = fakeSandboxHost();
    host.container.running = true;
    await restoreSleepWindow(host);
    expect(host.container.inactivityTimeouts).toEqual([]);
  });
});

describe("keepSleeplessSandboxAwake", () => {
  it("sets the next alarm while a sandbox that never sleeps runs", async () => {
    const host = fakeSandboxHost();
    await startSandbox(host, { ...spec, sleep_after_ms: 0 });
    host.storage.alarm = null;
    await keepSleeplessSandboxAwake(host);
    expect(host.storage.alarm).not.toBeNull();
  });

  it("sets no alarm for a sandbox with a sleep window", async () => {
    const host = fakeSandboxHost();
    await startSandbox(host, spec);
    await keepSleeplessSandboxAwake(host);
    expect(host.storage.alarm).toBeNull();
  });

  it("sets no alarm once the container stopped", async () => {
    const host = fakeSandboxHost();
    await startSandbox(host, { ...spec, sleep_after_ms: 0 });
    host.storage.alarm = null;
    host.container.running = false;
    await keepSleeplessSandboxAwake(host);
    expect(host.storage.alarm).toBeNull();
  });
});

function processAlive(dir: string): boolean {
  return spawnSync("sh", ["-c", PROCESS_ALIVE, "sh", dir]).status === 0;
}

describe("the process scripts in a shell", () => {
  let root: string;
  let bin: string;
  let sleeper: ChildProcess;

  function run(dir: string, ...argv: string[]): number | null {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    return spawnSync("sh", ["-c", RUN_PROCESS, "sh", dir, ...argv], { env }).status;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artfct-processes-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "setsid"), '#!/bin/sh\nexec "$@"\n');
    chmodSync(join(bin, "setsid"), 0o755);
    sleeper = spawn("sleep", ["60"]);
  });

  afterAll(() => {
    sleeper.kill();
    rmSync(root, { recursive: true, force: true });
  });

  it("records the pid, the output, and the exit code of a process", () => {
    const dir = join(root, "done");
    expect(run(dir, "sh", "-c", "echo out; echo err >&2; exit 3")).toBe(0);
    expect(readFileSync(join(dir, "pid"), "utf8")).toMatch(/^\d+\n$/);
    expect(readFileSync(join(dir, "stdout.log"), "utf8")).toBe("out\n");
    expect(readFileSync(join(dir, "stderr.log"), "utf8")).toBe("err\n");
    expect(readFileSync(join(dir, "exit-code"), "utf8")).toBe("3\n");
  });

  it("replaces the directory of an earlier process with the same name", () => {
    const dir = join(root, "again");
    run(dir, "sh", "-c", "exit 1");
    run(dir, "sh", "-c", "exit 0");
    expect(readFileSync(join(dir, "exit-code"), "utf8")).toBe("0\n");
  });

  it("finds a process gone once it recorded its exit code", () => {
    const dir = join(root, "exited");
    run(dir, "true");
    expect(processAlive(dir)).toBe(false);
  });

  it("finds no process without its directory", () => {
    expect(processAlive(join(root, "missing"))).toBe(false);
  });

  it("finds a process alive while it starts, before it records its pid", () => {
    const dir = join(root, "starting");
    mkdirSync(dir);
    expect(processAlive(dir)).toBe(true);
  });

  it("finds a process alive while its pid runs", () => {
    const dir = join(root, "running");
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), `${sleeper.pid}\n`);
    expect(processAlive(dir)).toBe(true);
  });

  it("finds a process gone once its pid ended without an exit code", () => {
    const dir = join(root, "lost");
    mkdirSync(dir);
    const ended = spawnSync("sh", ["-c", "echo $$"]).stdout.toString();
    writeFileSync(join(dir, "pid"), ended);
    expect(processAlive(dir)).toBe(false);
  });
});
