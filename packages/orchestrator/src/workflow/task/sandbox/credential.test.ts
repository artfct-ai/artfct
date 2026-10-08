import { GITHUB_CODE_REVIEW } from "@artfct-ai/adapters/code/github/review";
import type { MintedToken } from "@artfct-ai/adapters/code/types";
import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import type { TaskRow } from "../../store/tasks";
import {
  armTokenRefresh,
  credentialExpiring,
  CREDENTIAL_REFRESH_MARGIN_MS,
  refreshToken,
  mintSandboxGithubTokens,
  mintWorkflowRepoToken,
  TOKEN_RETRY_S,
} from "./credential";
import { fakeConnection, seedTask, type FakeRuntime } from "../../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../../test/scenario";

const TASK = "wf_x.1";
const REPO = "acme/app";
const HOUR_MS = 3_600_000;
const CLOCK = 1_000_000_000_000;

function seedPair(workflow: FakeRuntime) {
  workflow.patchState({ repo: { full: REPO } });
  const author = seedTask(workflow, { stage: "implement", branch: "artfct/wf_x-1-fix" });
  const reviewer = seedTask(workflow, {
    task_id: "wf_x.2",
    stage: "implement",
    role: "reviewer",
    job_id: author.job_id,
  });
  return { author, reviewer };
}

type Minted = {
  workflow: FakeRuntime;
  code: FakeCodeHost;
  credential: Awaited<ReturnType<typeof mintWorkflowRepoToken>>;
};

function minting(makeHost: () => FakeCodeHost, role: "author" | "reviewer"): Scenario<Minted> {
  return (run) =>
    freshRuntime(async (workflow) => {
      const code = makeHost();
      workflow.codeHostInstance = code;
      const credential = await mintWorkflowRepoToken(workflow, seedPair(workflow)[role]);
      await run({ workflow, code, credential });
    });
}

const mintedWithoutRepository: Scenario<Minted> = (run) =>
  freshRuntime(async (workflow) => {
    const code = new FakeCodeHost();
    workflow.codeHostInstance = code;
    const credential = await mintWorkflowRepoToken(workflow, seedTask(workflow));
    await run({ workflow, code, credential });
  });

describe("mintWorkflowRepoToken", () => {
  describe("a reviewer run", () => {
    const minted = minting(() => new FakeCodeHost(), "reviewer");

    it("gives back a credential with an end on it", () =>
      minted(({ credential }) => {
        expect(credential).toEqual({ token: "ghs_fake", expiresAt: expect.any(Number) });
      }));

    it("mints it with the permissions the artifact kind allows a reviewer", () =>
      minted(({ code }) => {
        expect(code.argsOf("mintToken")).toEqual([[REPO, GITHUB_CODE_REVIEW.permissions]]);
      }));
  });

  describe("an author task", () => {
    const minted = minting(() => new FakeCodeHost(), "author");

    it("gives back the installation credential", () =>
      minted(({ credential }) => {
        expect(credential?.token).toBe("ghs_fake");
      }));

    it("gives back an end in the future", () =>
      minted(({ credential }) => {
        expect(credential?.expiresAt).toBeGreaterThan(Date.now());
      }));

    it("mints it for the workflow's repository with every permission granted there", () =>
      minted(({ code }) => {
        expect(code.argsOf("mintToken")).toEqual([[REPO, undefined]]);
      }));
  });

  describe("a workflow with no repository", () => {
    it("has no credential", () =>
      mintedWithoutRepository(({ credential }) => {
        expect(credential).toBeNull();
      }));

    it("mints nothing", () =>
      mintedWithoutRepository(({ code }) => {
        expect(code.argsOf("mintToken")).toEqual([]);
      }));
  });

  describe("a host that will not mint", () => {
    const minted = minting(() => new FakeCodeHost({ failing: true }), "reviewer");

    it("has no credential", () =>
      minted(({ credential }) => {
        expect(credential).toBeNull();
      }));

    it("logs the failure", () =>
      minted(({ workflow }) => {
        expect(workflow.lines.some((line) => line.includes("credential mint failed"))).toBe(true);
      }));
  });

  describe("a runtime without a code host", () => {
    it("has no credential", () =>
      freshRuntime(async (workflow) => {
        expect(await mintWorkflowRepoToken(workflow, seedPair(workflow).reviewer)).toBeNull();
      }));
  });
});

describe("credentialExpiring", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

  it("is false for a task that holds no credential", () =>
    freshRuntime((workflow) => {
      seedTask(workflow);
      expect(credentialExpiring(workflow.store.requireSandbox(TASK), nowMs)).toBe(false);
    }));

  it("is true inside the refresh margin", () =>
    freshRuntime((workflow) => {
      seedTask(
        workflow,
        {},
        { credential_expires_at: new Date(nowMs + CREDENTIAL_REFRESH_MARGIN_MS - 1).toISOString() },
      );
      expect(credentialExpiring(workflow.store.requireSandbox(TASK), nowMs)).toBe(true);
    }));

  it("is false outside the refresh margin", () =>
    freshRuntime((workflow) => {
      seedTask(
        workflow,
        {},
        {
          credential_expires_at: new Date(
            nowMs + CREDENTIAL_REFRESH_MARGIN_MS + 60_000,
          ).toISOString(),
        },
      );
      expect(credentialExpiring(workflow.store.requireSandbox(TASK), nowMs)).toBe(false);
    }));
});

type Minting = { workflow: FakeRuntime; code: FakeCodeHost };

function appHost(): FakeCodeHost {
  return new FakeCodeHost({ token: { token: "ghs_1", expiresAt: Date.now() + HOUR_MS } });
}

function refreshing(
  makeHost: () => FakeCodeHost,
  setUp: (workflow: FakeRuntime) => void,
): Scenario<Minting> {
  return (run) =>
    freshRuntime(async (workflow) => {
      const code = makeHost();
      workflow.codeHostInstance = code;
      workflow.patchState({ repo: { full: REPO } });
      setUp(workflow);
      await refreshToken(workflow, { task_id: TASK });
      await run({ workflow, code });
    });
}

describe("armTokenRefresh", () => {
  describe("a token with an hour left on it", () => {
    const armed = scenario(freshRuntime, (workflow) => {
      workflow.clock = CLOCK;
      seedTask(workflow, {}, { token_schedule: "old" });
      return armTokenRefresh(workflow, workflow.store.requireSandbox(TASK), CLOCK + HOUR_MS);
    });

    it("cancels the refresh already armed", () =>
      armed((workflow) => {
        expect(workflow.cancelled).toEqual(["old"]);
      }));

    it("schedules the refresh for the margin before the token dies", () =>
      armed((workflow) => {
        expect(workflow.alarmsFor("refreshToken")[0]?.delay).toBe(
          (HOUR_MS - CREDENTIAL_REFRESH_MARGIN_MS) / 1000,
        );
      }));

    it("records the alarm and the expiry on the task", () =>
      armed((workflow) => {
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          token_schedule: workflow.alarmsFor("refreshToken")[0]?.id,
          credential_expires_at: new Date(CLOCK + HOUR_MS).toISOString(),
        });
      }));
  });

  describe("a token that dies sooner than the retry interval", () => {
    const soon = scenario(freshRuntime, (workflow) => {
      workflow.clock = CLOCK;
      seedTask(workflow);
      return armTokenRefresh(workflow, workflow.store.requireSandbox(TASK), CLOCK + 1000);
    });

    it("waits the retry interval instead", () =>
      soon((workflow) => {
        expect(workflow.alarmsFor("refreshToken")[0]?.delay).toBe(TOKEN_RETRY_S);
      }));
  });
});

describe("refreshToken", () => {
  describe("an App installation with the bridge connected", () => {
    const refreshed = refreshing(appHost, (workflow) => {
      seedTask(workflow, {}, { token_schedule: "t1" });
      workflow.sockets.push(fakeConnection(TASK, 1).connection);
    });

    it("mints for the workflow's repository", () =>
      refreshed(({ code }) => {
        expect(code.argsOf("mintToken")).toEqual([[REPO, undefined]]);
      }));

    it("writes the fresh token into the sandbox", () =>
      refreshed(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([`refreshGithubTokens ${TASK} ghs_1`]);
      }));

    it("arms the next refresh well past the retry interval", () =>
      refreshed(({ workflow }) => {
        expect(workflow.alarmsFor("refreshToken")[0]?.delay).toBeGreaterThan(TOKEN_RETRY_S);
      }));

    it("records the next alarm on the task", () =>
      refreshed(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).token_schedule).toBe(
          workflow.alarmsFor("refreshToken")[0]!.id,
        );
      }));

    it("records when the new credential dies", () =>
      refreshed(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).credential_expires_at).not.toBeNull();
      }));

    it("logs the refresh", () =>
      refreshed(({ workflow }) => {
        expect(workflow.lines).toContain("credential refreshed in the sandbox");
      }));
  });

  describe("a sandbox with no bridge on it", () => {
    const asleep = refreshing(appHost, (workflow) => {
      seedTask(workflow, {}, { token_schedule: "t1" });
    });

    it("asks the code host for nothing", () =>
      asleep(({ code }) => {
        expect(code.calls).toEqual([]);
      }));

    it("writes nothing into the sandbox", () =>
      asleep(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("schedules no refresh", () =>
      asleep(({ workflow }) => {
        expect(workflow.alarmsFor("refreshToken")).toHaveLength(0);
      }));

    it("forgets the alarm, leaving the next hello to refresh", () =>
      asleep(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).token_schedule).toBeNull();
      }));
  });

  describe("a code host that will not mint", () => {
    const failed = refreshing(
      () => new FakeCodeHost({ failing: true }),
      (workflow) => {
        seedTask(workflow);
        workflow.sockets.push(fakeConnection(TASK, 1).connection);
      },
    );

    it("logs the failure", () =>
      failed(({ workflow }) => {
        expect(workflow.lines).toEqual([expect.stringMatching(/^credential mint failed: /)]);
      }));

    it("writes nothing into the sandbox", () =>
      failed(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("tries again after the retry interval", () =>
      failed(({ workflow }) => {
        expect(workflow.alarmsFor("refreshToken")[0]?.delay).toBe(TOKEN_RETRY_S);
      }));

    it("records the retry on the task", () =>
      failed(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).token_schedule).toBe(
          workflow.alarmsFor("refreshToken")[0]!.id,
        );
      }));
  });

  describe("a runtime with no code host", () => {
    const offline = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow);
      await refreshToken(workflow, { task_id: TASK });
    });

    it("schedules nothing", () =>
      offline((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));
  });

  describe("a task that already finished", () => {
    const finished = refreshing(appHost, (workflow) => {
      seedTask(workflow, { status: "done" });
    });

    it("schedules nothing", () =>
      finished(({ workflow }) => {
        expect(workflow.alarms).toEqual([]);
      }));

    it("asks the code host for nothing", () =>
      finished(({ code }) => {
        expect(code.calls).toEqual([]);
      }));
  });
});

function allowReadingEveryRepository(workflow: FakeRuntime): void {
  const { orchestrator } = workflow.config();
  workflow.patchConfig({
    orchestrator: { ...orchestrator, sandbox: { ...orchestrator.sandbox, read_all_repos: true } },
  });
}

class ReadRefusingHost extends FakeCodeHost {
  override async mintAllReposReadToken(): Promise<MintedToken> {
    throw new Error("read refused");
  }
}

type SandboxMinted = {
  workflow: FakeRuntime;
  code: FakeCodeHost;
  tokens: Awaited<ReturnType<typeof mintSandboxGithubTokens>>;
};

function mintingForSandbox(
  makeHost: () => FakeCodeHost,
  setUp: (workflow: FakeRuntime) => TaskRow,
): Scenario<SandboxMinted> {
  return (run) =>
    freshRuntime(async (workflow) => {
      const code = makeHost();
      workflow.codeHostInstance = code;
      const tokens = await mintSandboxGithubTokens(workflow, setUp(workflow));
      await run({ workflow, code, tokens });
    });
}

function twoTokenHost(): FakeCodeHost {
  return new FakeCodeHost({
    token: { token: "ghs_1", expiresAt: CLOCK + HOUR_MS },
    allReposReadToken: { token: "ghs_read", expiresAt: CLOCK + HOUR_MS / 2 },
  });
}

describe("mintSandboxGithubTokens", () => {
  describe("a deployment that keeps sandboxes to the task's repository", () => {
    const minted = mintingForSandbox(twoTokenHost, (workflow) => seedPair(workflow).author);

    it("gives back the workflow repo token alone", () =>
      minted(({ tokens }) => {
        expect(tokens).toEqual({
          workflowRepoToken: "ghs_1",
          allReposReadToken: null,
          expiresAt: CLOCK + HOUR_MS,
        });
      }));

    it("does not mint an all-repos read token", () =>
      minted(({ code }) => {
        expect(code.argsOf("mintAllReposReadToken")).toEqual([]);
      }));
  });

  describe("a deployment that lets sandboxes read every repository", () => {
    const minted = mintingForSandbox(twoTokenHost, (workflow) => {
      allowReadingEveryRepository(workflow);
      return seedPair(workflow).reviewer;
    });

    it("gives back the all-repos read token, routed away from the workflow repository", () =>
      minted(({ tokens }) => {
        expect(tokens?.allReposReadToken).toEqual({ token: "ghs_read", workflow_repo: REPO });
      }));

    it("keeps the workflow repo token on the narrowed permissions", () =>
      minted(({ code, tokens }) => {
        expect(tokens?.workflowRepoToken).toBe("ghs_1");
        expect(code.argsOf("mintToken")).toEqual([[REPO, GITHUB_CODE_REVIEW.permissions]]);
      }));

    it("ends when the first of the two tokens dies", () =>
      minted(({ tokens }) => {
        expect(tokens?.expiresAt).toBe(CLOCK + HOUR_MS / 2);
      }));
  });

  describe("a deployment that lets sandboxes read every repository, on a workflow with no repository", () => {
    const minted = mintingForSandbox(twoTokenHost, (workflow) => {
      allowReadingEveryRepository(workflow);
      return seedTask(workflow);
    });

    it("has no tokens", () =>
      minted(({ tokens }) => {
        expect(tokens).toBeNull();
      }));

    it("mints neither token", () =>
      minted(({ code }) => {
        expect(code.calls).toEqual([]);
      }));
  });

  describe("a code host that will not mint the all-repos read token", () => {
    const minted = mintingForSandbox(
      () => new ReadRefusingHost(),
      (workflow) => {
        allowReadingEveryRepository(workflow);
        return seedPair(workflow).author;
      },
    );

    it("still gives back the workflow repo token, without an all-repos read token", () =>
      minted(({ tokens }) => {
        expect(tokens).toMatchObject({ workflowRepoToken: "ghs_fake", allReposReadToken: null });
      }));

    it("logs the failure", () =>
      minted(({ workflow }) => {
        expect(workflow.lines).toEqual([
          expect.stringMatching(/^all-repos read token mint failed: /),
        ]);
      }));
  });
});

describe("refreshToken on a deployment that lets sandboxes read every repository", () => {
  const refreshed = refreshing(twoTokenHost, (workflow) => {
    workflow.clock = CLOCK;
    allowReadingEveryRepository(workflow);
    seedTask(workflow, {}, { token_schedule: "t1" });
    workflow.sockets.push(fakeConnection(TASK, 1).connection);
  });

  it("mints both tokens", () =>
    refreshed(({ code }) => {
      expect(code.calls.map((call) => call.method)).toEqual(["mintToken", "mintAllReposReadToken"]);
    }));

  it("writes both fresh tokens into the sandbox", () =>
    refreshed(({ workflow }) => {
      expect(workflow.sandboxProvider.calls).toEqual([
        `refreshGithubTokens ${TASK} ghs_1 read ghs_read ${REPO}`,
      ]);
    }));

  it("records when the first of the two tokens dies", () =>
    refreshed(({ workflow }) => {
      expect(workflow.store.requireSandbox(TASK).credential_expires_at).toBe(
        new Date(CLOCK + HOUR_MS / 2).toISOString(),
      );
    }));
});
