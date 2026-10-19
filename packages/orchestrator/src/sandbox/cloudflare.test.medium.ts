import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CloudflareSandboxProvider, type SandboxStub } from "./cloudflare";
import type { AllReposReadToken, SandboxRef, SandboxStartSpec } from "./spec";

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
  workflow_repo_token: "ghs_1",
  all_repos_read_token: null,
  env: { ARTFCT_TASK_ID: "wf_x.1" },
  files: [],
  setup_commands: [],
  sleep_after_ms: 1_800_000,
  startup_timeout_ms: 2_700_000,
};

const READ: AllReposReadToken = { token: "ghs_read", workflow_repo: "acme/app" };

type Call = { sandbox: SandboxRef; method: keyof SandboxStub; args: unknown[] };

class RecordingStubs {
  calls: Call[] = [];
  bridge = true;
  file = '{"findings":[]}';

  open(sandbox: SandboxRef): SandboxStub {
    const record = (method: keyof SandboxStub, args: unknown[]) =>
      this.calls.push({ sandbox, method, args });
    return {
      start: async (startSpec) => void record("start", [startSpec]),
      refreshGithubTokens: async (token, read) => void record("refreshGithubTokens", [token, read]),
      keepAlive: async () => void record("keepAlive", []),
      bridgeRunning: async (generation) => {
        record("bridgeRunning", [generation]);
        return this.bridge;
      },
      readFile: async (path) => {
        record("readFile", [path]);
        return this.file;
      },
      destroy: async () => void record("destroy", []),
    };
  }
}

describe("CloudflareSandboxProvider", () => {
  let stubs: RecordingStubs;
  let subject: CloudflareSandboxProvider;

  beforeEach(() => {
    stubs = new RecordingStubs();
    subject = new CloudflareSandboxProvider(env, (sandbox) => stubs.open(sandbox));
  });

  it("starts the sandbox of the spec's id and size with the whole spec", async () => {
    await subject.start(spec);
    expect(stubs.calls).toEqual([{ sandbox: SANDBOX, method: "start", args: [spec] }]);
  });

  it("hands both GitHub tokens to the sandbox", async () => {
    await subject.refreshGithubTokens(SANDBOX, "ghs_2", READ);
    expect(stubs.calls).toEqual([
      { sandbox: SANDBOX, method: "refreshGithubTokens", args: ["ghs_2", READ] },
    ]);
  });

  it("asks the sandbox about the bridge of the generation", async () => {
    stubs.bridge = false;
    expect(await subject.bridgeRunning(SANDBOX, 3)).toBe(false);
    expect(stubs.calls).toEqual([{ sandbox: SANDBOX, method: "bridgeRunning", args: [3] }]);
  });

  it("reads the text of a file in the sandbox", async () => {
    expect(await subject.readFile(SANDBOX, "/workspace/research.json")).toBe('{"findings":[]}');
    expect(stubs.calls).toEqual([
      { sandbox: SANDBOX, method: "readFile", args: ["/workspace/research.json"] },
    ]);
  });

  it("calls the sandbox to keep it alive, then destroys it", async () => {
    await subject.keepAlive(SANDBOX);
    await subject.destroy(SANDBOX);
    expect(stubs.calls.map((call) => call.method)).toEqual(["keepAlive", "destroy"]);
  });
});

describe("CloudflareSandboxProvider on the Worker's bindings", () => {
  it("reaches the sandbox Durable Object of each size", async () => {
    const subject = new CloudflareSandboxProvider(env);
    await subject.keepAlive({ id: "wf_x.1", size: "small" });
    await subject.keepAlive({ id: "wf_x.1", size: "large" });
  });
});
