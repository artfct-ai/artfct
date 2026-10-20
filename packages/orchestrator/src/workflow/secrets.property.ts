import { describe, expect, it, spyOn } from "bun:test";
import type { MintedToken } from "@artfct-ai/adapters/code/types";
import type { Gateway } from "@artfct-ai/adapters/gateway/types";
import type { Harness, HarnessAdapter } from "@artfct-ai/adapters/harness/types";
import {
  FAKE_ALL_REPOS_READ_TOKEN,
  FAKE_WORKFLOW_REPO_TOKEN,
  FakeCodeHost,
} from "@artfct-ai/adapters/test/fake-code-host";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import { gateway, harness, mcpCredential } from "../clients";
import type { McpCapability } from "../config/adapters";
import type { GatewayProvider } from "../config/gateway";
import { McpServers } from "../config/mcp-servers";
import { createDb } from "../db/client";
import { saveLinearInstall } from "../db/linear-installs";
import { createWorkflow } from "../db/workflows";
import { WORKER_SECRETS } from "../env";
import { FakeBridge } from "../../test/fake-bridge";
import { FakeRuntime, seedTask, patchStagePlan } from "../../test/fake-runtime";
import { openMemoryDb } from "../../test/memory-db";
import {
  DEV_VAR_HANDLING,
  devVarCredentials,
  outputExposures,
  secretMarker,
  secretsReachOnlyTheirDestinations,
  type Credential,
} from "../../test/orchestrator-secret-invariants";
import { SecretWatch } from "../../test/secret-watch";
import { sqliteD1 } from "../../test/sqlite-d1";
import { testEnv } from "../../test/test-env";
import {
  agentCancels,
  agentPromptsAuthor,
  agentStartsTask,
  authorFails,
  authorHitsARecoverableFailure,
  authorPromptFails,
  authorTurnEnds,
  firstArtifactAppears,
  personCancels,
  sandboxComesUp,
  timerFires,
  type Timer,
} from "../../test/workflow-actions";
import {
  REQUEST_TEXTS,
  STAGE_OF,
  WorkflowWorld,
  type ArtifactKind,
  type WorkflowAction,
  type WorldSetup,
} from "../../test/workflow-world";
import { refreshToken } from "./task/sandbox/credential";
import { provision } from "./task/sandbox/sandbox";
import type { TaskAlarm } from "./task/harness/timers";

const DEPLOYMENT_RUNS = 1_000;

const SEQUENCE_RUNS = 100;

const TASK = "wf_x.1";

const SECRET_NAMES = Object.entries(DEV_VAR_HANDLING)
  .filter(([, handling]) => handling.kind !== "setting")
  .map(([name]) => name);

const ARTIFACT_KINDS: ArtifactKind[] = ["pull", "page", "issues"];

const MINTED_TOKEN = "ghs_minted-9c1e";

const READ_TOKEN = "ghs_read-9c1e";

const LINEAR_ACCESS_TOKEN = "lin_access-9c1e";

const LINEAR_REFRESH_TOKEN = "lin_refresh-9c1e";

const FAR_FUTURE = Date.parse("2100-01-01T00:00:00Z");

class DeploymentRuntime extends FakeRuntime {
  override harness(name: Harness): HarnessAdapter {
    return harness(this.env, name);
  }

  override gateway(provider: GatewayProvider): Gateway | null {
    return gateway(this.env, provider, this.config().adapters.gateway.region);
  }

  override mcpCredential(capability: McpCapability): Promise<string | null> {
    return mcpCredential({ env: this.env, capability, adapters: this.config().adapters });
  }
}

const secretReference = fc.oneof(
  { arbitrary: fc.constantFrom("CF_READ_API_TOKEN", "UNSET_TOKEN"), weight: 6 },
  { arbitrary: fc.constantFrom(...WORKER_SECRETS), weight: 1 },
);

const mcpServerEntry = fc.oneof(
  fc.record({
    name: fc.constantFrom("vendor", "metrics", "search"),
    url: secretReference.map((name) => `https://mcp.example.com/\${${name}}`),
    headers: secretReference.map((name) => ({ Authorization: `Bearer \${${name}}` })),
  }),
  fc.record({
    name: fc.constantFrom("vendor", "metrics", "search"),
    command: fc.constant("npx"),
    args: fc.array(
      secretReference.map((name) => `--token=\${${name}}`),
      { maxLength: 2 },
    ),
    env: secretReference.map((name) => ({ TOKEN: `\${${name}}` })),
  }),
);

const deployment = fc.record({
  secretsSet: fc.subarray(SECRET_NAMES),
  gatewayProvider: fc.constantFrom<GatewayProvider>("openrouter", "cloudflare"),
  documents: fc.constantFrom("notion" as const, "linear" as const),
  harnessName: fc.constantFrom<Harness>("claude-code", "opencode"),
  model: fc.constantFrom("claude-opus-5-5", "openrouter/deepseek/deepseek-v4.1-flash"),
  artifact: fc.constantFrom(...ARTIFACT_KINDS),
  linearInstalled: fc.boolean(),
  hostFails: fc.boolean(),
  readAllRepos: fc.boolean(),
  mcpServers: fc.array(mcpServerEntry, { maxLength: 3 }),
});

type DeploymentCase = typeof deployment extends fc.Arbitrary<infer Case> ? Case : never;

function minted(token: string): MintedToken {
  return { token, expiresAt: FAR_FUTURE };
}

const DERIVED: Credential[] = [
  { kind: "workflow_repo_token", value: MINTED_TOKEN },
  { kind: "all_repos_read_token", value: READ_TOKEN },
  { kind: "tracker_access_token", value: LINEAR_ACCESS_TOKEN },
  { kind: "tracker_refresh_token", value: LINEAR_REFRESH_TOKEN },
];

const WORLD_MINTED_TOKENS: Credential[] = [
  { kind: "workflow_repo_token", value: FAKE_WORKFLOW_REPO_TOKEN },
  { kind: "all_repos_read_token", value: FAKE_ALL_REPOS_READ_TOKEN },
];

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

async function withConsoleCaptured<Result>(
  run: (lines: string[]) => Promise<Result>,
): Promise<Result> {
  const lines: string[] = [];
  const spies = CONSOLE_METHODS.map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    return await run(lines);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

type StartedDeployment = { refused: boolean; reachedSession: boolean; failedNearSecrets: boolean };

async function startDeployment(
  setup: DeploymentCase,
  consoleLines: readonly string[],
): Promise<StartedDeployment> {
  const servers = McpServers.safeParse(setup.mcpServers);
  if (!servers.success) return { refused: true, reachedSession: false, failedNearSecrets: false };
  const d1 = sqliteD1();
  const secrets = Object.fromEntries(setup.secretsSet.map((name) => [name, secretMarker(name)]));
  const env = { ...testEnv(), ...secrets, CF_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw", DB: d1 };
  const db = openMemoryDb();
  const workflow = new DeploymentRuntime(db, env);
  await createWorkflow(createDb(d1), workflow.store.requireWorkflowRow().workflow_id);
  if (setup.linearInstalled) {
    await saveLinearInstall(createDb(d1), {
      access_token: LINEAR_ACCESS_TOKEN,
      refresh_token: LINEAR_REFRESH_TOKEN,
      expires_at: new Date(FAR_FUTURE).toISOString(),
      scope: "read,write",
      organization_id: "org_acme",
      organization_name: "Acme",
      app_user_id: "app1",
    });
  }
  const config = workflow.config();
  workflow.patchConfig({
    adapters: {
      ...config.adapters,
      documents: { provider: setup.documents },
      gateway: { ...config.adapters.gateway, provider: setup.gatewayProvider },
    },
    mcp_servers: servers.data,
    orchestrator: {
      ...config.orchestrator,
      sandbox: { ...config.orchestrator.sandbox, read_all_repos: setup.readAllRepos },
    },
  });
  workflow.codeHostInstance = new FakeCodeHost({
    token: minted(MINTED_TOKEN),
    allReposReadToken: minted(READ_TOKEN),
    failing: setup.hostFails,
  });
  patchStagePlan(workflow, { repo: "acme/app" });
  const stage = STAGE_OF[setup.artifact];
  seedTask(
    workflow,
    { status: "queued", stage, branch: `artfct/wf_x-1-${stage}`, model: setup.model },
    { harness: setup.harnessName },
  );
  await provision(workflow, TASK);
  const task = workflow.store.requireTask(TASK);
  const bridge = task.status === "provisioning" ? await FakeBridge.connect(workflow, task) : null;
  new SecretWatch().check(workflow, {
    db,
    bridges: bridge ? [bridge] : [],
    derived: DERIVED,
    outputs: { console: consoleLines },
  });
  return {
    refused: false,
    reachedSession: bridge !== null,
    failedNearSecrets:
      setup.secretsSet.length > 0 && workflow.store.requireTask(TASK).status !== "provisioning",
  };
}

const TIMERS: Timer[] = ["hello_timeout", "no_progress", "wall_clock", "bridge_lost", "keep_alive"];

function action(label: string, run: WorkflowAction["run"]): WorkflowAction {
  return { run, toString: () => label };
}

const workflowRestarts = action("the workflow restarts", (world) => world.restart());

function tokenRefreshFires(sandboxRefuses: boolean): WorkflowAction {
  return action(`the token refresh fires, the sandbox refuses ${sandboxRefuses}`, async (world) => {
    const alarm = world.workflow.alarmsFor("refreshToken")[0];
    if (!alarm) return;
    await world.workflow.cancelAlarm(alarm.id);
    const provider = world.workflow.sandboxProvider;
    const write = provider.refreshGithubTokens.bind(provider);
    if (sandboxRefuses) {
      provider.refreshGithubTokens = async () => {
        throw new Error("the sandbox did not answer");
      };
    }
    try {
      await refreshToken(world.workflow, alarm.payload as TaskAlarm);
    } finally {
      provider.refreshGithubTokens = write;
    }
  });
}

const sandboxStartFails = action("a sandbox start fails", async (world) => {
  const waiting = world.tasksAwaitingSandbox()[0];
  if (!waiting) return;
  const provider = world.workflow.sandboxProvider;
  const start = provider.start.bind(provider);
  provider.start = async (spec) => {
    provider.specs.push(spec);
    throw new Error("no capacity");
  };
  try {
    await world.provisionSandboxOf(waiting.task_id);
  } finally {
    provider.start = start;
  }
});

const sandboxStartsWhileHostIsDown = action("a sandbox starts while the host is down", (world) => {
  const waiting = world.tasksAwaitingSandbox()[0];
  if (!waiting) return Promise.resolve();
  return world.whileHostIsDown(() => world.startSandboxOf(waiting.task_id));
});

const author = fc.nat(3);

const workflowAction: fc.Arbitrary<WorkflowAction> = fc.oneof(
  fc
    .tuple(author, fc.constantFrom("changed" as const, "same" as const))
    .map(([index, revision]) => authorTurnEnds(index, revision)),
  author.map((index) => authorPromptFails(index, "same")),
  author.map((index) => authorFails(index)),
  author.map((index) => authorHitsARecoverableFailure(index)),
  author.map((index) => firstArtifactAppears(index, "author_text")),
  author.map((index) => agentPromptsAuthor(index)),
  author.map((index) => agentCancels(index, "author")),
  fc
    .constantFrom(...ARTIFACT_KINDS)
    .map((kind) => agentStartsTask(kind, "no_issue", REQUEST_TEXTS[1] ?? "")),
  fc.constant(personCancels("control")),
  fc.constantFrom(sandboxComesUp("dials_in"), sandboxComesUp("stays_silent")),
  fc.tuple(fc.constantFrom(...TIMERS), fc.nat(3)).map(([timer, pick]) => timerFires(timer, pick)),
  fc.constant(workflowRestarts),
  fc.boolean().map(tokenRefreshFires),
  fc.constant(sandboxStartFails),
  fc.constant(sandboxStartsWhileHostIsDown),
);

const worldSetup: fc.Arbitrary<WorldSetup> = fc.record({
  opening: fc.constant("job" as const),
  artifact: fc.constantFrom(...ARTIFACT_KINDS),
  refiners: fc.constantFrom("none" as const, "reviewer" as const),
  research: fc.constant(false),
  pageAuthor: fc.constant("harness" as const),
  checksOnPush: fc.constant("passed" as const),
  pageEnding: fc.constant("acceptance" as const),
  origin: fc.constantFrom("chat" as const, "tracker" as const),
  firstInput: fc.constant("request" as const),
  subject: fc.constant("none" as const),
  sandboxStart: fc.constant("on_an_action" as const),
  pageBranch: fc.constant(false),
});

const ERRORS_NEAR_SECRETS = [
  "credential mint failed",
  "credential refresh failed",
  "sandbox start failed",
];

describe("worker secret invariants", () => {
  it(
    "a sandbox start and its harness session carry each secret only to its destinations",
    async () => {
      let refused = 0;
      let sessions = 0;
      let failuresNearSecrets = 0;
      await fc.assert(
        fc.asyncProperty(deployment, async (setup) => {
          const started = await withConsoleCaptured((lines) => startDeployment(setup, lines));
          if (started.refused) refused++;
          if (started.reachedSession) sessions++;
          if (started.failedNearSecrets) failuresNearSecrets++;
        }),
        propertyRuns("worker secrets in a sandbox start", DEPLOYMENT_RUNS),
      );
      expect(refused).toBeGreaterThan(0);
      expect(sessions).toBeGreaterThan(0);
      expect(failuresNearSecrets).toBeGreaterThan(0);
    },
    propertyTimeoutMs(30_000, DEPLOYMENT_RUNS),
  );

  it(
    "a workflow carries no secret to an output on random sequences with failures and restarts",
    async () => {
      let errorsNearSecrets = 0;
      await fc.assert(
        fc.asyncProperty(
          worldSetup,
          fc.array(workflowAction, { maxLength: 25 }),
          async (setup, actions) => {
            const { world, consoleLines } = await withConsoleCaptured(async (captured) => {
              const opened = await WorkflowWorld.open(setup);
              for (const step of actions) await opened.apply(step);
              return { world: opened, consoleLines: captured };
            });
            secretsReachOnlyTheirDestinations({
              credentials: [...devVarCredentials(world.workflow.env), ...WORLD_MINTED_TOKENS],
              exposures: outputExposures("console", consoleLines),
            });
            const lines = world.workflow.lines;
            if (lines.some((line) => ERRORS_NEAR_SECRETS.some((error) => line.startsWith(error))))
              errorsNearSecrets++;
          },
        ),
        propertyRuns("worker secrets on workflow sequences", SEQUENCE_RUNS),
      );
      expect(errorsNearSecrets).toBeGreaterThan(0);
    },
    propertyTimeoutMs(60_000, SEQUENCE_RUNS),
  );
});
