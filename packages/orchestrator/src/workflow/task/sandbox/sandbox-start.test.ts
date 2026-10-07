import type { CommitAuthor, MintedToken, Permissions } from "@artfct-ai/adapters/code/types";
import type { SandboxStartSpec } from "../../../sandbox/spec";
import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "bun:test";
import { Adapters } from "../../../config/adapters";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { FakeSandboxProvider } from "../../../../test/fake-sandbox";
import { seedTask, type FakeRuntime } from "../../../../test/fake-runtime";
import { scenario } from "../../../../test/scenario";
import { provision, startSandbox } from "./sandbox";
import { onHelloTimeout } from "../harness/timers";
import type { TaskRow } from "../../store/tasks";
import { CREDENTIAL_REFRESH_MARGIN_MS, TOKEN_RETRY_S } from "./credential";

const TASK = "wf_x.1";
const JOB = "wf_x-1";

function installedSkills(workflow: FakeRuntime): string[] {
  return (workflow.sandboxProvider.specs[0]?.files ?? [])
    .map((file) => /\/skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1])
    .filter((name) => name !== undefined);
}

class FailingStart extends FakeSandboxProvider {
  constructor(private readonly failure = "no capacity") {
    super();
  }

  override async start(): Promise<void> {
    throw new Error(this.failure);
  }
}

class FailsFirstStart extends FakeSandboxProvider {
  override async start(spec: SandboxStartSpec): Promise<void> {
    if (this.specs.length === 0) {
      this.specs.push(spec);
      throw new Error("clone timed out");
    }
    await super.start(spec);
  }
}

class NeverFinishesStart extends FakeSandboxProvider {
  override async start(): Promise<void> {
    await new Promise<never>(() => {});
  }
}

class RefusesCommitAuthor extends FakeCodeHost {
  override async commitAuthor(): Promise<CommitAuthor> {
    throw new Error("github GET /app: 401 Bad credentials");
  }
}

class CountingMints extends FakeCodeHost {
  private mints = 0;

  override async mintToken(repo: string, permissions?: Permissions): Promise<MintedToken> {
    const minted = await super.mintToken(repo, permissions);
    this.mints += 1;
    return { ...minted, token: `ghs_${this.mints}` };
  }
}

describe("provision", () => {
  describe("a queued task whose sandbox start has not returned", () => {
    const starting = scenario(freshRuntime, async (workflow) => {
      workflow.sandboxProvider = new NeverFinishesStart();
      seedTask(workflow, { status: "queued" }, { generation: 0 });
      void provision(workflow, TASK);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("is provisioning with a hello timeout already armed", () =>
      starting((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          hello_schedule: workflow.alarmsFor("onHelloTimeout")[0]!.id,
        });
      }));

    describe("and the hello timeout fires while this instance still awaits the start", () => {
      const waited = scenario(starting, (workflow) =>
        onHelloTimeout(workflow, { task_id: TASK, generation: 1 }),
      );

      it("keeps the generation and counts no restart", () =>
        waited((workflow) => {
          expect(workflow.store.requireSandbox(TASK)).toMatchObject({ generation: 1, restarts: 0 });
        }));

      it("arms another hello timeout for the same generation", () =>
        waited((workflow) => {
          expect(workflow.alarmsFor("onHelloTimeout").at(-1)).toMatchObject({
            id: workflow.store.requireSandbox(TASK).hello_schedule,
            payload: { task_id: TASK, generation: 1 },
          });
        }));
    });
  });

  describe("a queued task", () => {
    const provisioned = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { status: "queued" }, { generation: 0 });
      return provision(workflow, TASK);
    });

    it("starts it as its first generation", () =>
      provisioned((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ generation: 1 });
      }));

    it("mints a new bridge token", () =>
      provisioned((workflow) => {
        expect(workflow.store.requireSandbox(TASK).bridge_token).not.toBe("tok");
      }));

    it("starts one sandbox", () =>
      provisioned((workflow) => {
        expect(workflow.sandboxProvider.specs).toHaveLength(1);
      }));

    it("starts it on the task's own bridge token, with no repository", () =>
      provisioned((workflow) => {
        expect(workflow.sandboxProvider.specs[0]).toMatchObject({
          sandbox_id: TASK,
          size: "large",
          token: workflow.store.requireSandbox(TASK).bridge_token,
          generation: 1,
          repo: null,
          github_token: null,
        });
      }));

    it("records the hello timeout it armed", () =>
      provisioned((workflow) => {
        expect(workflow.store.requireSandbox(TASK).hello_schedule).toBe(
          workflow.alarmsFor("onHelloTimeout")[0]!.id,
        );
      }));

    it("arms that alarm alone", () =>
      provisioned((workflow) => {
        expect(workflow.alarms.map((alarm) => alarm.method)).toEqual(["onHelloTimeout"]);
      }));

    it("arms no token refresh, since it has no token", () =>
      provisioned((workflow) => {
        expect(workflow.store.requireSandbox(TASK).token_schedule).toBeNull();
      }));

    it("logs the generation it started", () =>
      provisioned((workflow) => {
        expect(workflow.lines).toContain("sandbox started gen=1 resume=false");
      }));
  });

  describe("a queued task of a stage the workflow definition no longer declares", () => {
    const dropped = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { stage: "retired", status: "queued" }, { generation: 0 });
      return provision(workflow, TASK);
    });

    it("starts no sandbox", () =>
      dropped((workflow) => {
        expect(workflow.sandboxProvider.specs).toEqual([]);
      }));

    it("fails the job and names the stage", () =>
      dropped((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
        expect(workflow.posted).toEqual([
          {
            type: "failed",
            job_id: JOB,
            reason: "Stage retired is not in the workflow definition.",
          },
        ]);
      }));
  });

  describe("a task that is working, and a task id nothing answers to", () => {
    const asked = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow);
      await provision(workflow, TASK);
      await provision(workflow, "wf_x.404");
    });

    it("touches no sandbox", () =>
      asked((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("leaves the working task on its generation", () =>
      asked((workflow) => {
        expect(workflow.store.requireSandbox(TASK).generation).toBe(1);
      }));
  });
});

describe("startSandbox", () => {
  describe("an opencode task on the default gateway", () => {
    let gateway: FakeGateway;
    const started = scenario(freshRuntime, (workflow) => {
      gateway = new FakeGateway({ baseUrl: "https://gw" });
      workflow.gatewayInstance = gateway;
      workflow.harnessInstance = harnessAdapter("opencode");
      const seeded = seedTask(workflow, { status: "queued", model: "m" }, { harness: "opencode" });
      return startSandbox(workflow, seeded, false);
    });

    it("asks for the gateway the config names", () =>
      started((workflow) => {
        expect(workflow.gatewayRequests).toEqual([workflow.config().adapters.gateway.provider]);
      }));

    it("tags both routes with the workflow, the task and the stage", () =>
      started(() => {
        const metadata = { workflow_id: "wf_x", task_id: TASK, stage: "design" };
        expect(gateway.calls).toEqual([
          { method: "anthropicRoute", args: [metadata] },
          { method: "compatRoute", args: ["m", metadata] },
        ]);
      }));

    it("routes the sandbox through the gateway", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]?.files[0]?.content).toContain("https://gw/compat");
      }));
  });

  describe("an author task on the design stage", () => {
    const started = scenario(freshRuntime, (workflow) =>
      startSandbox(workflow, seedTask(workflow, { status: "queued" }), false),
    );

    it("installs the skill its produce activity names first", () =>
      started((workflow) => {
        expect(installedSkills(workflow)[0]).toBe("design");
      }));

    it("installs every other skill, so the task's skill can name them", () =>
      started((workflow) => {
        expect(installedSkills(workflow)).toContain("review-conduct");
      }));
  });

  describe("a reviewer run on a page stage when Notion holds the pages", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.patchConfig({ adapters: Adapters.parse({ documents: { provider: "notion" } }) });
      workflow.mcpCredentialValue = "ntn_secret";
      const reviewer = seedTask(workflow, { status: "queued", role: "reviewer", refiner_index: 0 });
      return startSandbox(workflow, reviewer, false);
    });

    it("gives the sandbox the Notion CLI's credential", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]?.env).toMatchObject({
          NOTION_API_TOKEN: "ntn_secret",
          NOTION_KEYRING: "0",
        });
      }));
  });

  describe("a reviewer run on a page stage when Linear holds the pages", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.mcpCredentialValue = "lin_oauth_a";
      const reviewer = seedTask(workflow, { status: "queued", role: "reviewer", refiner_index: 0 });
      return startSandbox(workflow, reviewer, false);
    });

    it("gives the sandbox no Notion credential", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]?.env).not.toHaveProperty("NOTION_API_TOKEN");
      }));
  });

  describe("a reviewer run on the design stage", () => {
    const started = scenario(freshRuntime, (workflow) =>
      startSandbox(
        workflow,
        seedTask(workflow, { status: "queued", role: "reviewer", refiner_index: 0 }),
        false,
      ),
    );

    it("installs its entry's skill first, not the stage's", () =>
      started((workflow) => {
        expect(installedSkills(workflow)[0]).toBe("design-review");
      }));

    it("starts in the small sandbox", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]?.size).toBe("small");
      }));
  });

  describe("a task whose stage names a skill no directory carries", () => {
    const started = scenario(freshRuntime, (workflow) => {
      const { stages } = workflow.workflowDefinition();
      workflow.patchWorkflowDefinition({
        stages: stages.map((stage) =>
          stage.name === "design"
            ? { ...stage, author: { produce: { ...stage.author.produce, skill: "invent-it" } } }
            : stage,
        ),
      });
      return startSandbox(workflow, seedTask(workflow, { status: "queued" }), false);
    });

    it("fails the task naming the skill file the deployment lacks", () =>
      started((workflow) => {
        expect(workflow.posted).toEqual([
          {
            type: "failed",
            job_id: JOB,
            reason: expect.stringMatching(/no skill invent-it\. Add skills\/invent-it\/SKILL\.md/),
          },
        ]);
      }));
  });

  describe("a gateway that cannot carry the task's model", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.gatewayInstance = {
        compatRoute: () => {
          throw new Error("model m needs an OpenRouter key.");
        },
        anthropicRoute: () => null,
        decisions: () => null,
        models: async () => null,
      };
      const seeded = seedTask(workflow, { status: "queued", model: "m" }, { harness: "opencode" });
      return startSandbox(workflow, seeded, false);
    });

    it("fails the task", () =>
      started((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
      }));

    it("posts the gateway's reason unchanged", () =>
      started((workflow) => {
        expect(workflow.posted).toEqual([
          { type: "failed", job_id: JOB, reason: "Error: model m needs an OpenRouter key." },
        ]);
      }));
  });

  describe("a stage that needs a repository the workflow does not know", () => {
    const started = scenario(freshRuntime, (workflow) =>
      startSandbox(
        workflow,
        seedTask(workflow, { status: "queued", stage: "implement", branch: null }),
        false,
      ),
    );

    it("fails the task", () =>
      started((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
      }));

    it("destroys the sandbox it will not use", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`]);
      }));

    it("posts the reason unchanged", () =>
      started((workflow) => {
        expect(workflow.posted).toEqual([
          { type: "failed", job_id: JOB, reason: "stage needs a repository but none is known" },
        ]);
      }));
  });

  describe("a code host that refuses the commit author lookup", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.codeHostInstance = new RefusesCommitAuthor();
      workflow.patchState({ repo: { full: "acme/app" } });
      return startSandbox(workflow, seedTask(workflow, { status: "queued" }), false);
    });

    it("fails the task after its restarts are used up", () =>
      started((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
      }));

    it("posts that the lookup failed and the task whose log holds the details", () =>
      started((workflow) => {
        expect(workflow.posted).toEqual([
          {
            type: "failed",
            job_id: JOB,
            reason: `The commit author lookup failed. The details are in the logs of task ${TASK}.`,
          },
        ]);
      }));

    it("logs the error text of the code host", () =>
      started((workflow) => {
        expect(workflow.lines).toContain(
          "commit author lookup failed: Error: github GET /app: 401 Bad credentials",
        );
      }));

    it("starts no sandbox", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs).toEqual([]);
      }));
  });

  describe("a sandbox that will not start", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.sandboxProvider = new FailingStart();
      return startSandbox(workflow, seedTask(workflow, { status: "queued" }), false);
    });

    it("fails the task after its restarts are used up", () =>
      started((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
        expect(workflow.store.requireSandbox(TASK).restarts).toBe(2);
      }));

    it("posts that the sandbox start failed and the task whose log holds the details", () =>
      started((workflow) => {
        expect(workflow.posted).toEqual([
          {
            type: "failed",
            job_id: JOB,
            reason: `The sandbox start failed. The details are in the logs of task ${TASK}.`,
          },
        ]);
      }));

    it("keeps the error text of the provider out of the post", () =>
      started((workflow) => {
        expect(JSON.stringify(workflow.posted)).not.toContain("no capacity");
      }));

    it("logs the error text of the provider", () =>
      started((workflow) => {
        expect(workflow.lines).toContain("sandbox start failed: Error: no capacity");
      }));

    it("tells the orchestrator agent the task whose log holds the details", () =>
      started((workflow) => {
        expect(workflow.noteTexts()).toContainEqual(
          expect.stringContaining(
            `Job ${JOB} failed: its author ${TASK} stopped (The sandbox start failed. The details are in the logs of task ${TASK}.). Retry its work with start_job, or call fail_workflow.`,
          ),
        );
      }));

    it("keeps the error text of the provider from the orchestrator agent", () =>
      started((workflow) => {
        expect(workflow.noteTexts().join("\n")).not.toContain("no capacity");
      }));

    it("leaves no alarm armed", () =>
      started((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));
  });

  describe("a sandbox whose start fails with a long error text", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.sandboxProvider = new FailingStart("x".repeat(5000));
      return startSandbox(workflow, seedTask(workflow, { status: "queued" }), false);
    });

    it("logs the first 4000 characters of it", () =>
      started((workflow) => {
        expect(workflow.lines).toContain(
          `sandbox start failed: Error: ${"x".repeat(4000 - "Error: ".length)}`,
        );
      }));
  });

  describe("a sandbox that fails its first start", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.sandboxProvider = new FailsFirstStart();
      return startSandbox(workflow, seedTask(workflow, { status: "queued" }), false);
    });

    it("destroys the failed sandbox and starts a fresh one", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`, `start ${TASK}`]);
      }));

    it("writes a board note that names the task whose log holds the details", () =>
      started((workflow) => {
        expect(workflow.store.todoRow(TASK)?.note).toBe(
          `Restarted in a fresh sandbox: The sandbox start failed. The details are in the logs of task ${TASK}.`,
        );
      }));

    it("logs the error text of the provider", () =>
      started((workflow) => {
        expect(workflow.lines).toContain("sandbox start failed: Error: clone timed out");
      }));

    it("keeps the task provisioning on its first restart", () =>
      started((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("provisioning");
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ generation: 3, restarts: 1 });
      }));
  });

  describe("a restart of a task that was mid-turn", () => {
    let seeded: TaskRow;
    const restarted = scenario(freshRuntime, (workflow) => {
      seeded = seedTask(
        workflow,
        {},
        {
          session_id: "s1",
          prompt_in_flight: 1,
          keepalive_schedule: "k1",
          wall_schedule: "w1",
          bridge_closed_at: new Date().toISOString(),
        },
      );
      workflow.store.insertRpc(TASK, "session/prompt", "prompt");
      return startSandbox(workflow, seeded, true);
    });

    it("cancels the keepalive of the old sandbox", () =>
      restarted((workflow) => {
        expect(workflow.cancelled[0]).toBe("k1");
      }));

    it("starts a new generation and keeps the wall clock alarm", () =>
      restarted((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          generation: 2,
          session_id: null,
          prompt_in_flight: 0,
          keepalive_schedule: null,
          bridge_closed_at: null,
          wall_schedule: "w1",
        });
      }));

    it("mints a new bridge token", () =>
      restarted((workflow) => {
        expect(workflow.store.requireSandbox(TASK).bridge_token).not.toBe("tok");
      }));

    it("drops the handshake the old generation had open", () =>
      restarted((workflow) => {
        expect(workflow.store.handshakePending(TASK)).toBe(false);
      }));

    it("arms the hello timeout alone", () =>
      restarted((workflow) => {
        expect(workflow.alarms.map((alarm) => alarm.method)).toEqual(["onHelloTimeout"]);
      }));

    it("arms it for the new generation", () =>
      restarted((workflow) => {
        expect(workflow.alarms[0]?.payload).toEqual({ task_id: TASK, generation: 2 });
      }));

    it("logs the generation it started", () =>
      restarted((workflow) => {
        expect(workflow.lines).toContain("sandbox started gen=2 resume=true");
      }));
  });

  describe("a document stage on a workflow with a repository", () => {
    const started = scenario(freshRuntime, (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost();
      workflow.patchState({ repo: { full: "acme/app" } });
      return startSandbox(
        workflow,
        seedTask(workflow, { status: "queued", stage: "design", branch: null }),
        false,
      );
    });

    it("hands the sandbox the repository and the token too", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]).toMatchObject({
          github_token: "ghs_fake",
          repo: { clone_url: "https://github.com/acme/app.git", branch: null },
        });
      }));
  });

  describe("a code stage on a workflow whose App token expires in an hour", () => {
    const ttlMs = 3_600_000;
    const started = scenario(freshRuntime, (workflow) => {
      workflow.clock = Date.now();
      workflow.codeHostInstance = new FakeCodeHost({
        token: { token: "ghs_1", expiresAt: workflow.clock + ttlMs },
      });
      workflow.patchState({ repo: { full: "acme/app" } });
      return startSandbox(
        workflow,
        seedTask(workflow, { status: "queued", stage: "implement", branch: "artfct/wf_x-1-fix" }),
        false,
      );
    });

    it("hands the sandbox the fresh token and the branch", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]).toMatchObject({
          github_token: "ghs_1",
          repo: { clone_url: "https://github.com/acme/app.git", branch: "artfct/wf_x-1-fix" },
        });
      }));

    it("commits as the code host's account", () =>
      started((workflow) => {
        expect(workflow.sandboxProvider.specs[0]?.repo?.author).toEqual({
          name: "acme-review[bot]",
          email: "4242+acme-review[bot]@users.noreply.github.com",
        });
      }));

    it("arms the refresh a margin before the token expires", () =>
      started((workflow) => {
        expect(workflow.alarmsFor("refreshToken")[0]?.delay).toBe(
          (ttlMs - CREDENTIAL_REFRESH_MARGIN_MS) / 1000,
        );
      }));

    it("arms it further out than a retry", () =>
      started((workflow) => {
        expect(workflow.alarmsFor("refreshToken")[0]?.delay).toBeGreaterThan(TOKEN_RETRY_S);
      }));

    it("records the refresh alarm on the task", () =>
      started((workflow) => {
        expect(workflow.store.requireSandbox(TASK).token_schedule).toBe(
          workflow.alarmsFor("refreshToken")[0]!.id,
        );
      }));

    it("records the expiry the code host reported", () =>
      started((workflow) => {
        expect(workflow.store.requireSandbox(TASK).credential_expires_at).toBe(
          new Date(workflow.now() + ttlMs).toISOString(),
        );
      }));
  });

  describe("a restart on a workflow with a repository", () => {
    let code: CountingMints;
    const restarted = scenario(freshRuntime, async (workflow) => {
      code = new CountingMints();
      workflow.codeHostInstance = code;
      workflow.patchState({ repo: { full: "acme/app" } });
      const seeded = seedTask(workflow, { status: "queued", stage: "design", branch: null });
      await startSandbox(workflow, seeded, false);
      await startSandbox(workflow, workflow.store.requireTask(TASK), true);
    });

    it("mints for the workflow's repository both times", () =>
      restarted(() => {
        expect(code.argsOf("mintToken")).toEqual([
          ["acme/app", undefined],
          ["acme/app", undefined],
        ]);
      }));

    it("hands each generation a new token, never the cached one", () =>
      restarted((workflow) => {
        expect(workflow.sandboxProvider.specs.map((started) => started.github_token)).toEqual([
          "ghs_1",
          "ghs_2",
        ]);
      }));

    it("keeps one refresh alarm, since the old one goes with the old token", () =>
      restarted((workflow) => {
        expect(workflow.alarmsFor("refreshToken")).toHaveLength(1);
      }));
  });
});
