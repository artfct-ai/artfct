import type { Process, ProcessStatus } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloudflareSandboxProvider,
  sleepOptions,
  type SandboxHandle,
  type SleepOptions,
} from "./cloudflare";
import {
  GITHUB_TOKEN_DIR,
  GITHUB_TOKEN_FILE,
  startupScript,
  type SandboxRef,
  type SandboxStartSpec,
} from "./spec";

const SANDBOX: SandboxRef = { id: "wf_x.1", size: "large" };

const spec: SandboxStartSpec = {
  sandbox_id: SANDBOX.id,
  size: SANDBOX.size,
  workflow_id: "wf_x",
  task_id: "wf_x.1",
  harness: "claude-code",
  model: "claude-sonnet-5",
  dial_url: "wss://ao.example.com/bridge/wf_x/wf_x.1",
  token: "tok",
  generation: 2,
  workspace: "/workspace/repo",
  repo: { clone_url: "https://github.com/acme/app.git", branch: "artfct/wf_x-1-fix", author: null },
  github_token: "ghs_1",
  env: { ARTFCT_TASK_ID: "wf_x.1" },
  files: [],
  setup_commands: [],
  sleep_after_ms: 1_800_000,
  startup_timeout_ms: 2_700_000,
};

const STARTUP_SCRIPT = "/tmp/artfct-startup.sh";
const AUTH_SCRIPT = "/tmp/artfct-github-auth.sh";

type Opened = { id: string; options: SleepOptions };

class FakeHandle {
  envVars: Record<string, string | undefined> = {};
  files = new Map<string, string>();
  dirs: string[] = [];
  commands: Array<{ command: string; timeout?: number }> = [];
  processes: Array<{
    command: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    processId?: string;
  }> = [];
  statuses = new Map<string, ProcessStatus>();
  lookups: string[] = [];
  reads: Array<{ path: string; encoding: string }> = [];
  listed = 0;
  destroyed = 0;

  constructor(private failing: Record<string, string> = {}) {}

  handle(): SandboxHandle {
    const fake: Partial<SandboxHandle> = {
      setEnvVars: async (vars) => {
        this.envVars = { ...this.envVars, ...vars };
      },
      writeFile: async (path, content) => {
        if (typeof content !== "string") throw new Error("the fake sandbox writes text only");
        this.files.set(path, content);
        return { success: true, path, exitCode: 0, timestamp: "" };
      },
      mkdir: async (path) => {
        this.dirs.push(path);
        return { success: true, path, recursive: true, exitCode: 0, timestamp: "" };
      },
      exec: async (command, options) => {
        this.commands.push({ command, timeout: options?.timeout });
        const stderr = this.failing[command];
        return {
          success: stderr === undefined,
          exitCode: stderr === undefined ? 0 : 1,
          stdout: "",
          stderr: stderr ?? "",
          command,
          duration: 1,
          timestamp: "",
        };
      },
      startProcess: async (command, options) => {
        this.processes.push({
          command,
          cwd: options?.cwd,
          env: options?.env,
          processId: options?.processId,
        });
        return {} as never;
      },
      getProcess: async (id) => {
        this.lookups.push(id);
        const status = this.statuses.get(id);
        return status === undefined ? null : ({ id, status } as Process);
      },
      readFile: async (path, options) => {
        this.reads.push({ path, encoding: options.encoding });
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`File not found: ${path}`);
        return { content };
      },
      listProcesses: async () => {
        this.listed += 1;
        return [];
      },
      destroy: async () => {
        this.destroyed += 1;
      },
    };
    return fake as SandboxHandle;
  }
}

function failureMessage(call: Promise<unknown>): Promise<string | null> {
  return call.then(
    () => null,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );
}

describe("CloudflareSandboxProvider", () => {
  let fake: FakeHandle;
  let opened: Opened[];
  let subject: CloudflareSandboxProvider;

  function useProvider(failing: Record<string, string> = {}): void {
    fake = new FakeHandle(failing);
    opened = [];
    subject = new CloudflareSandboxProvider(env, (sandbox, options) => {
      opened.push({ id: sandbox.id, options });
      return fake.handle();
    });
  }

  beforeEach(() => {
    useProvider();
  });

  describe("start on a task with a repo and a token", () => {
    beforeEach(async () => {
      await subject.start(spec);
    });

    it("opens the sandbox with its sleep window", () => {
      expect(opened).toEqual([{ id: "wf_x.1", options: { sleepAfter: "30m" } }]);
    });

    it("sets the task env and the clone url", () => {
      expect(fake.envVars).toEqual({
        ARTFCT_TASK_ID: "wf_x.1",
        ARTFCT_CLONE_URL: "https://github.com/acme/app.git",
      });
    });

    it("makes the token directory", () => {
      expect(fake.dirs).toEqual([GITHUB_TOKEN_DIR]);
    });

    it("writes the token file", () => {
      expect(fake.files.get(GITHUB_TOKEN_FILE)).toBe("ghs_1");
    });

    it("writes the startup script", () => {
      expect(fake.files.get(STARTUP_SCRIPT)).toBe(startupScript(spec));
    });

    it("runs the startup script within the spec's time limit", () => {
      expect(fake.commands).toEqual([{ command: `bash ${STARTUP_SCRIPT}`, timeout: 2_700_000 }]);
    });

    it("starts the bridge in the workspace with its token in the process env", () => {
      expect(fake.processes).toEqual([
        {
          command:
            "artfct-bridge --harness 'claude-code' --dial 'wss://ao.example.com/bridge/wf_x/wf_x.1' --cwd '/workspace/repo' --model 'claude-sonnet-5' --generation 2",
          cwd: "/workspace/repo",
          env: { ARTFCT_TOKEN: "tok" },
          processId: "artfct-bridge-2",
        },
      ]);
    });
  });

  describe("start on a task with harness files", () => {
    const file = { path: "/home/node/.config/opencode/opencode.json", content: "{}" };

    beforeEach(async () => {
      await subject.start({ ...spec, github_token: null, files: [file] });
    });

    it("makes the directory of the file", () => {
      expect(fake.dirs).toEqual(["/home/node/.config/opencode"]);
    });

    it("writes the file before the startup script", () => {
      expect([...fake.files.keys()]).toEqual([file.path, STARTUP_SCRIPT]);
    });

    it("writes the content of the file", () => {
      expect(fake.files.get(file.path)).toBe("{}");
    });
  });

  describe("start on a task with no repo and no token", () => {
    beforeEach(async () => {
      await subject.start({ ...spec, repo: null, github_token: null, sleep_after_ms: 0 });
    });

    it("keeps the sandbox alive", () => {
      expect(opened[0]?.options).toEqual({ keepAlive: true });
    });

    it("sets no clone url", () => {
      expect(fake.envVars).toEqual({ ARTFCT_TASK_ID: "wf_x.1" });
    });

    it("makes no directory", () => {
      expect(fake.dirs).toEqual([]);
    });

    it("writes the startup script alone", () => {
      expect([...fake.files.keys()]).toEqual([STARTUP_SCRIPT]);
    });

    it("starts the bridge", () => {
      expect(fake.processes).toHaveLength(1);
    });
  });

  describe("start when the startup script fails", () => {
    let failure: string | null;

    beforeEach(async () => {
      useProvider({ [`bash ${STARTUP_SCRIPT}`]: "fatal: clone failed" });
      failure = await failureMessage(subject.start(spec));
    });

    it("fails with the stderr of the script", () => {
      expect(failure).toBe("sandbox startup failed: fatal: clone failed");
    });

    it("never starts the bridge", () => {
      expect(fake.processes).toEqual([]);
    });
  });

  describe("refreshGithubToken", () => {
    beforeEach(async () => {
      await subject.refreshGithubToken(SANDBOX, "ghs_2");
    });

    it("opens the sandbox without sleep options", () => {
      expect(opened).toEqual([{ id: "wf_x.1", options: {} }]);
    });

    it("rewrites the token file", () => {
      expect(fake.files.get(GITHUB_TOKEN_FILE)).toBe("ghs_2");
    });

    it("writes an auth script with the strict shell options", () => {
      expect((fake.files.get(AUTH_SCRIPT) ?? "").split("\n")[0]).toBe("set -euo pipefail");
    });

    it("logs gh in from the token file", () => {
      expect(fake.files.get(AUTH_SCRIPT) ?? "").toContain(
        `gh auth login --with-token < ${GITHUB_TOKEN_FILE}`,
      );
    });

    it("runs the auth script", () => {
      expect(fake.commands).toEqual([{ command: `bash ${AUTH_SCRIPT}`, timeout: 60_000 }]);
    });
  });

  describe("refreshGithubToken when the auth script fails", () => {
    it("reports the stderr of the script", async () => {
      useProvider({ [`bash ${AUTH_SCRIPT}`]: "gh: bad token" });
      expect(await failureMessage(subject.refreshGithubToken(SANDBOX, "ghs_2"))).toBe(
        "github auth failed: gh: bad token",
      );
    });
  });

  describe("start on an id whose sandbox was destroyed", () => {
    let first: FakeHandle;
    let second: FakeHandle;
    let ids: string[];

    beforeEach(async () => {
      first = new FakeHandle();
      second = new FakeHandle();
      ids = [];
      let live = first;
      const provider = new CloudflareSandboxProvider(env, (sandbox) => {
        ids.push(sandbox.id);
        return live.handle();
      });
      await provider.start(spec);
      await provider.destroy(SANDBOX);
      live = second;
      await provider.start(spec);
    });

    it("destroys the first sandbox once", () => {
      expect(first.destroyed).toBe(1);
    });

    it("opens the same id every time", () => {
      expect(new Set(ids)).toEqual(new Set(["wf_x.1"]));
    });

    it("sets the env and the clone url on the new sandbox", () => {
      expect(second.envVars).toEqual({
        ARTFCT_TASK_ID: "wf_x.1",
        ARTFCT_CLONE_URL: "https://github.com/acme/app.git",
      });
    });

    it("writes the token file again, which the destroyed sandbox took with it", () => {
      expect(second.files.get(GITHUB_TOKEN_FILE)).toBe("ghs_1");
    });

    it("runs the startup script again, so an empty workspace is cloned", () => {
      expect(second.commands).toEqual([{ command: `bash ${STARTUP_SCRIPT}`, timeout: 2_700_000 }]);
      expect(second.files.get(STARTUP_SCRIPT)).toContain("git clone");
    });

    it("starts a bridge on the new sandbox", () => {
      expect(second.processes).toHaveLength(1);
    });

    it("leaves the destroyed sandbox with nothing new on it", () => {
      expect(first.processes).toHaveLength(1);
      expect(first.commands).toHaveLength(1);
    });
  });

  describe("start of a large sandbox", () => {
    it("opens the sandbox in its size", async () => {
      const refs: SandboxRef[] = [];
      const provider = new CloudflareSandboxProvider(env, (sandbox) => {
        refs.push(sandbox);
        return new FakeHandle().handle();
      });
      await provider.start(spec);
      expect(refs[0]).toEqual(SANDBOX);
    });
  });

  describe("readFile", () => {
    let content: string;

    beforeEach(async () => {
      fake.files.set("/workspace/research.json", '{"findings":[]}');
      content = await subject.readFile(SANDBOX, "/workspace/research.json");
    });

    it("reads container file text through sandbox handle", () => {
      expect(content).toBe('{"findings":[]}');
    });

    it("opens the named sandbox without sleep options", () => {
      expect(opened).toEqual([{ id: "wf_x.1", options: {} }]);
    });

    it("asks the sandbox for the file as text", () => {
      expect(fake.reads).toEqual([{ path: "/workspace/research.json", encoding: "utf-8" }]);
    });
  });

  describe("readFile on a missing file", () => {
    it("fails with the error of the sandbox", async () => {
      expect(await failureMessage(subject.readFile(SANDBOX, "/workspace/missing.json"))).toBe(
        "File not found: /workspace/missing.json",
      );
    });
  });

  describe("bridgeRunning", () => {
    it("looks up the bridge process of the generation", async () => {
      await subject.bridgeRunning(SANDBOX, 3);
      expect(fake.lookups).toEqual(["artfct-bridge-3"]);
    });

    it("answers true while the bridge runs", async () => {
      fake.statuses.set("artfct-bridge-3", "running");
      expect(await subject.bridgeRunning(SANDBOX, 3)).toBe(true);
    });

    it("answers true while the bridge starts", async () => {
      fake.statuses.set("artfct-bridge-3", "starting");
      expect(await subject.bridgeRunning(SANDBOX, 3)).toBe(true);
    });

    it("answers false once the bridge exited", async () => {
      fake.statuses.set("artfct-bridge-3", "completed");
      expect(await subject.bridgeRunning(SANDBOX, 3)).toBe(false);
    });

    it("answers false when the container has no record of the bridge", async () => {
      expect(await subject.bridgeRunning(SANDBOX, 3)).toBe(false);
    });
  });

  describe("keepAlive, setEnv, and destroy on one sandbox", () => {
    beforeEach(async () => {
      await subject.keepAlive(SANDBOX);
      await subject.setEnv(SANDBOX, { GITHUB_TOKEN: "x" });
      await subject.destroy(SANDBOX);
    });

    it("opens the named sandbox for every call", () => {
      expect(opened.map((entry) => entry.id)).toEqual(["wf_x.1", "wf_x.1", "wf_x.1"]);
    });

    it("touches the sandbox once to keep it alive", () => {
      expect(fake.listed).toBe(1);
    });

    it("sets the env it was given", () => {
      expect(fake.envVars).toEqual({ GITHUB_TOKEN: "x" });
    });

    it("destroys the sandbox once", () => {
      expect(fake.destroyed).toBe(1);
    });
  });
});

describe("sleepOptions", () => {
  it("gives no options without a sleep window", () => {
    expect(sleepOptions(undefined)).toEqual({});
  });

  it("keeps the sandbox alive when the window is zero", () => {
    expect(sleepOptions(0)).toEqual({ keepAlive: true });
  });

  it("states a window of thirty minutes in minutes", () => {
    expect(sleepOptions(1_800_000)).toEqual({ sleepAfter: "30m" });
  });

  it("rounds a window under a minute up to one", () => {
    expect(sleepOptions(1000)).toEqual({ sleepAfter: "1m" });
  });
});
