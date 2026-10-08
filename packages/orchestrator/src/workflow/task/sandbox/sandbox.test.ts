import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import { HARNESSES, type Skill } from "@artfct-ai/adapters/harness/types";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { FakeHarness } from "@artfct-ai/adapters/test/fake-harness";
import { type ResolvedStage, resolveStage } from "../../../config/stage";
import { describe, expect, it } from "bun:test";
import { registeredConfig } from "../../../config/register-config";
import { buildSandboxEnv, buildStartSpec, WORKSPACE, type StartSpecInput } from "./sandbox";
import type { JobRow, SandboxRow, TaskRow } from "../../store/tasks";

const job: JobRow = {
  job_id: "wf_x-1",
  stage: "design",
  issue_id: null,
  issue_key: null,
  input_key: null,
  preceding_job_id: null,
  input_ref: null,
  input_url: null,
  branch: "artfct/wf_x-1-fix",
  brief: "",
  author_harness: null,
  author_model: null,
  research_payload: null,
  selection: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const task: TaskRow = {
  task_id: "wf_x.1",
  job_id: "wf_x-1",
  role: "author",
  refiner_index: null,
  result: null,
  model: "claude-opus-5",
  status: "provisioning",
  paused_at: null,
  cost_usd: 0,
  started_at: "2026-01-01T00:00:00.000Z",
  summary: "",
};

const sandbox: SandboxRow = {
  task_id: "wf_x.1",
  harness: "claude-code",
  generation: 1,
  bridge_token: "tok",
  session_id: null,
  last_progress_at: "2026-01-01T00:00:00.000Z",
  prompt_in_flight: 0,
  turn_text: "",
  bridge_closed_at: null,
  no_progress_schedule: null,
  wall_schedule: null,
  hello_schedule: null,
  keepalive_schedule: null,
  token_schedule: null,
  credential_expires_at: null,
  nudged: 0,
  restarts: 0,
};

function stage(name: string): ResolvedStage {
  const { config, workflowDefinition } = registeredConfig();
  return resolveStage(
    config,
    workflowDefinition.stages.find((candidate) => candidate.name === name)!,
  );
}

const skills: Skill[] = [
  {
    name: "design-review",
    files: [
      { path: "SKILL.md", content: "---\nname: design-review\n---\n\nReview it.\n" },
      { path: "REFERENCE.md", content: "# Reference\n" },
      { path: "scripts/fill_form.py", content: "print('filled')\n" },
    ],
  },
  {
    name: "simplicity-principles",
    files: [{ path: "SKILL.md", content: "---\nname: simplicity-principles\n---\n\nJudge it.\n" }],
  },
];

const AUTHOR = { name: "acme-agent[bot]", email: "4242+acme-agent[bot]@users.noreply.github.com" };

const input: StartSpecInput = {
  task,
  job,
  sandbox,
  stage: stage("design"),
  effort: undefined,
  skills,
  adapters: registeredConfig().config.adapters,
  workflowId: "wf_x",
  publicUrl: "https://ao.example.com",
  repo: { full: "acme/app" },
  commitAuthor: AUTHOR,
  credential: "ghs_1",
  githubRead: null,
  hostEnv: {},
  harness: harnessAdapter("claude-code", { claudeOauthToken: "sk-ant-oat" }),
  gateway: null,
  sleepAfterMs: 1_800_000,
  startupTimeoutMs: 900_000,
};

function spec(patch: Partial<StartSpecInput>) {
  const built = buildStartSpec({ ...input, ...patch });
  if ("error" in built) throw new Error(built.error);
  return built.spec;
}

const metadata = { workflow_id: "wf_x", task_id: "wf_x.1", stage: "design" };

describe("buildStartSpec", () => {
  describe("a task whose model is not the stage default", () => {
    const built = spec({});

    it("uses the task's model", () => {
      expect(built.model).toBe("claude-opus-5");
    });

    it("gives the harness the task's model too", () => {
      expect(built.env.ANTHROPIC_MODEL).toBe("claude-opus-5");
    });

    it("names the sandbox after the task", () => {
      expect(built.sandbox_id).toBe("wf_x.1");
    });

    it("dials the bridge of that workflow and task", () => {
      expect(built.dial_url).toBe("wss://ao.example.com/bridge/wf_x/wf_x.1");
    });

    it("gives the startup script the deployment's time limit", () => {
      expect(built.startup_timeout_ms).toBe(900_000);
    });
  });

  describe("an opencode task on a gateway", () => {
    const gateway = new FakeGateway({ baseUrl: "https://gw" });
    const built = spec({
      sandbox: { ...sandbox, harness: "opencode" },
      harness: harnessAdapter("opencode"),
      gateway: {
        anthropic: gateway.anthropicRoute(metadata),
        compat: gateway.compatRoute("claude-opus-5", metadata),
      },
    });

    it("writes the opencode config first", () => {
      expect(built.files[0]?.path).toBe("/home/node/.config/opencode/opencode.json");
    });

    it("passes the task model into that config", () => {
      expect(built.files[0]?.content).toContain("fake/claude-opus-5");
    });
  });

  describe("every harness", () => {
    const gateway = new FakeGateway({ baseUrl: "https://gw" });
    const routes = {
      anthropic: gateway.anthropicRoute(metadata),
      compat: gateway.compatRoute("claude-opus-5", metadata),
    };

    for (const name of HARNESSES) {
      const harness = harnessAdapter(name);
      const built = spec({ sandbox: { ...sandbox, harness: name }, harness, gateway: routes });

      it(`installs every file of the task's skills under the ${name} skills directory`, () => {
        const installed = built.files.filter((file) => file.path.startsWith(harness.skillsDir));
        expect(installed.map((file) => file.path)).toEqual([
          `${harness.skillsDir}/design-review/SKILL.md`,
          `${harness.skillsDir}/design-review/REFERENCE.md`,
          `${harness.skillsDir}/design-review/scripts/fill_form.py`,
          `${harness.skillsDir}/simplicity-principles/SKILL.md`,
        ]);
      });

      it(`writes the writing rules to the ${name} instructions file`, () => {
        const instructions = built.files.find((file) => file.path === harness.instructionsFile);
        expect(instructions?.content).toBe(`${registeredConfig().writingRules}\n`);
      });

      it(`keeps every ${name} file out of the checkout`, () => {
        for (const file of built.files) expect(file.path.startsWith(WORKSPACE)).toBe(false);
      });
    }
  });

  describe("a gateway with no Anthropic route", () => {
    const gateway = new FakeGateway({ anthropic: false });
    const routes = { anthropic: null, compat: gateway.compatRoute("claude-opus-5", metadata) };

    describe("with a Claude Code harness that has no subscription", () => {
      const built = buildStartSpec({
        ...input,
        gateway: routes,
        harness: harnessAdapter("claude-code"),
      });

      it("refuses, and names the endpoint it needs", () => {
        expect("error" in built ? built.error : "").toMatch(/Anthropic endpoint/);
      });
    });

    describe("with a Claude Code subscription", () => {
      it("builds the spec", () => {
        expect(spec({ gateway: routes })).toBeTruthy();
      });
    });

    describe("with an opencode harness, which needs no Anthropic route", () => {
      it("builds the spec", () => {
        expect(
          spec({
            sandbox: { ...sandbox, harness: "opencode" },
            harness: harnessAdapter("opencode"),
            gateway: routes,
          }),
        );
      });
    });
  });

  describe("a harness with setup env and files of its own", () => {
    const harness = new FakeHarness({
      setup: {
        env: { ARTFCT_STAGE: "theirs", HARNESS_KEY: "k" },
        files: [{ path: "/home/node/x", content: "y" }],
        commands: ["harness-tool init"],
      },
    });
    const built = spec({ harness });

    it("lays the harness env over the shared env", () => {
      expect(built.env).toMatchObject({
        ARTFCT_TASK_ID: "wf_x.1",
        ARTFCT_STAGE: "theirs",
        HARNESS_KEY: "k",
      });
    });

    it("carries the harness setup commands", () => {
      expect(built.setup_commands).toEqual(["harness-tool init"]);
    });

    it("carries the harness files ahead of the instructions and the skills", () => {
      expect(built.files[0]).toEqual({ path: "/home/node/x", content: "y" });
      expect(built.files[1]?.path).toBe("/home/node/.config/fake/AGENTS.md");
      expect(built.files[2]?.path).toBe("/home/node/.config/fake/skills/design-review/SKILL.md");
    });

    it("writes each skill file as the repository holds it", () => {
      const installed = built.files.find((file) =>
        file.path.endsWith("/design-review/scripts/fill_form.py"),
      );
      expect(installed?.content).toBe("print('filled')\n");
    });

    it("asks the harness for its setup with the task's model and repo", () => {
      expect(harness.calls[0]?.args[0]).toEqual({
        model: "claude-opus-5",
        effort: null,
        repoFull: "acme/app",
        gateway: null,
      });
    });
  });

  describe("a host reached through a CLI in the sandbox", () => {
    const built = spec({ hostEnv: { NOTION_API_TOKEN: "ntn_secret" } });

    it("puts the CLI's credential in the sandbox env", () => {
      expect(built.env.NOTION_API_TOKEN).toBe("ntn_secret");
    });
  });

  describe("a harness that refuses the task", () => {
    it("fails the spec in the harness's own words", () => {
      const harness = new FakeHarness({ setup: { error: "no way to reach the model" } });
      expect(buildStartSpec({ ...input, harness })).toEqual({
        error: "no way to reach the model",
      });
    });
  });

  describe("a stage that writes code, on a task with a branch", () => {
    const built = spec({ stage: stage("implement") });

    it("clones the branch without credentials in the url", () => {
      expect(built.repo).toEqual({
        clone_url: "https://github.com/acme/app.git",
        branch: "artfct/wf_x-1-fix",
        author: AUTHOR,
      });
    });

    it("hands the token over separately", () => {
      expect(built.github_token).toBe("ghs_1");
    });

    it("hands over no read token", () => {
      expect(built.github_read).toBeNull();
    });

    it("keeps the token out of GITHUB_TOKEN", () => {
      expect(built.env.GITHUB_TOKEN).toBeUndefined();
    });

    it("keeps the token out of GH_TOKEN", () => {
      expect(built.env.GH_TOKEN).toBeUndefined();
    });
  });

  describe("a task that may read every repository", () => {
    const read = { token: "ghs_read", task_repo: "acme/app" };
    const built = spec({ stage: stage("implement"), githubRead: read });

    it("hands the read token over beside the task token", () => {
      expect([built.github_token, built.github_read]).toEqual(["ghs_1", read]);
    });

    it("keeps the read token out of the environment", () => {
      expect(Object.values(built.env)).not.toContain("ghs_read");
    });
  });

  describe("a stage that only reads code, on a job with no branch", () => {
    const built = spec({ job: { ...job, branch: null } });

    it("clones the default branch", () => {
      expect(built.repo).toEqual({
        clone_url: "https://github.com/acme/app.git",
        branch: null,
        author: AUTHOR,
      });
    });

    it("hands the token over too", () => {
      expect(built.github_token).toBe("ghs_1");
    });

    it("names the repository in the environment", () => {
      expect(built.env.ARTFCT_REPO).toBe("acme/app");
    });
  });

  describe("a workflow that knows neither a repository nor a token", () => {
    const built = spec({ repo: null, credential: null });

    it("gives the sandbox no repository", () => {
      expect(built.repo).toBeNull();
    });

    it("gives the sandbox no token", () => {
      expect(built.github_token).toBeNull();
    });

    it("names no repository in the environment", () => {
      expect(built.env.ARTFCT_REPO).toBeUndefined();
    });
  });

  describe("a stage that needs a repository", () => {
    describe("with no repository known", () => {
      const built = buildStartSpec({ ...input, stage: stage("implement"), repo: null });

      it("refuses", () => {
        expect(built).toHaveProperty("error");
      });

      it("says the repository is what it misses", () => {
        expect("error" in built ? built.error : "").toMatch(/repository/);
      });
    });

    describe("with no branch on the job", () => {
      it("refuses", () => {
        expect(
          buildStartSpec({ ...input, stage: stage("implement"), job: { ...job, branch: null } }),
        ).toHaveProperty("error");
      });
    });
  });
});

const sandboxEnvInput = {
  workflowId: "wf_x",
  taskId: "wf_x.1",
  stageName: "implement",
  repoFull: "acme/app",
};

describe("buildSandboxEnv", () => {
  describe("a workflow with a repository", () => {
    it("identifies the task and the repository and disables git prompts", () => {
      expect(buildSandboxEnv(sandboxEnvInput)).toEqual({
        ARTFCT_TASK_ID: "wf_x.1",
        ARTFCT_WORKFLOW_ID: "wf_x",
        ARTFCT_STAGE: "implement",
        ARTFCT_REPO: "acme/app",
        GIT_TERMINAL_PROMPT: "0",
      });
    });
  });

  describe("a workflow that knows no repository", () => {
    const sandboxEnv = buildSandboxEnv({ ...sandboxEnvInput, repoFull: null });

    it("names no repository", () => {
      expect(sandboxEnv.ARTFCT_REPO).toBeUndefined();
    });

    it("carries no code host credential", () => {
      expect(sandboxEnv.GH_TOKEN).toBeUndefined();
      expect(sandboxEnv.GITHUB_TOKEN).toBeUndefined();
    });
  });
});
