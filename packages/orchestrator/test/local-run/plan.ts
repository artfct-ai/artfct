import { GithubCodeHost } from "@artfct-ai/adapters/code/github/code-host";
import type { CodeHost } from "@artfct-ai/adapters/code/types";
import { LinearDocuments } from "@artfct-ai/adapters/docs/linear/documents";
import { NotionDocuments } from "@artfct-ai/adapters/docs/notion/documents";
import type { Documents } from "@artfct-ai/adapters/docs/types";
import { CloudflareGateway } from "@artfct-ai/adapters/gateway/cloudflare/gateway";
import { OpenRouterGateway } from "@artfct-ai/adapters/gateway/openrouter/gateway";
import type { Gateway } from "@artfct-ai/adapters/gateway/types";
import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import type { Effort, HarnessCommand } from "@artfct-ai/adapters/harness/types";
import type { McpServer } from "@agentclientprotocol/sdk";
import { artifactCapability, artifactNeedsTaskCredential, cliEnv } from "../../src/clients";
import type { Config } from "../../src/config/config";
import { loadDeploymentConfig } from "../../src/config/register-config";
import type { McpCapability } from "../../src/config/providers";
import { loadHarnessSkills } from "../../src/config/skills";
import { resolveStage } from "../../src/config/stage";
import type { LoadedDeploymentConfig } from "../../src/config/types";
import type { SandboxStartSpec } from "../../src/sandbox/spec";
import { taskCredential } from "../../src/workflow/task/sandbox/credential";
import { produceCall, type ProduceCall } from "../../src/workflow/task/model-author";
import { firstPromptText } from "../../src/workflow/task/harness/prompt-queue";
import { buildStartSpec } from "../../src/workflow/task/sandbox/sandbox";
import { taskSettings } from "../../src/workflow/task/settings";
import { harnessMcpServers } from "../../src/workflow/task/sandbox/mcp-servers";
import type { TaskRow } from "../../src/workflow/store/tasks";
import templateConfig from "../template-config.json";
import { FakeRuntime } from "../fake-runtime";
import { openMemoryDb } from "../memory-db";
import { testEnv } from "../test-env";

/** The role name that picks the author of the stage. Any other name picks a refiner of it. */
export const AUTHOR_ROLE = "author";

const LOCAL_JOB = "local-1";
const AUTHOR_TASK = "local.1";
const REFINER_RUN = "local.2";

/** The values of `.dev.vars` a local run reads, by name. */
export type LocalSecrets = Readonly<Record<string, string | undefined>>;

/** What one local run is asked to do. */
export type LocalRunRequest = {
  stage: string;
  /** `author`, or the name of a reviewer or a polisher of the stage. */
  role: string;
  /** The artifact a refiner works on. An author takes none. */
  artifactUrl: string | null;
  title: string;
  request: string;
  brief: string;
  repoFull: string | null;
  branch: string | null;
};

/** What the container and the harness session of one local run start with. */
export type HarnessRunPlan = {
  execution: "harness";
  spec: SandboxStartSpec;
  command: HarnessCommand;
  effort: Effort | null;
  mcpServers: McpServer[];
  firstPrompt: string;
};

function warn(line: string): void {
  console.warn(line);
}

/** The produce activity of a model-call author, on the gateway the workflow sends it to. */
export type ModelRunPlan = {
  execution: "model";
  modelName: string;
  produce: ProduceCall;
};

/** What one local run does: a harness session in a container, or one model call. */
export type LocalRunPlan = HarnessRunPlan | ModelRunPlan;

/** The settings and the workflow definition of the template. */
export function productionConfig(): LoadedDeploymentConfig {
  return loadDeploymentConfig(templateConfig);
}

/**
 * The plan of one local run. It seeds an in-memory workflow with the task, then asks the
 * production code for the first prompt, the start spec, and the MCP servers.
 */
export async function planLocalRun(
  request: LocalRunRequest,
  secrets: LocalSecrets,
  loaded: LoadedDeploymentConfig = productionConfig(),
): Promise<LocalRunPlan | { error: string }> {
  const { config, workflowDefinition } = loaded;
  const workflow = new FakeRuntime(openMemoryDb(), testEnv());
  workflow.configOverride = config;
  workflow.workflowDefinitionOverride = workflowDefinition;
  workflow.codeHostInstance = codeHost(secrets);
  workflow.docsInstance = documents(config, secrets);
  workflow.gatewayInstance = gateway(config, secrets);
  workflow.patchState({
    workflow_id: "local",
    request: { title: request.title, text: request.request, links: [] },
    repo: request.repoFull ? { full: request.repoFull } : null,
  });

  const seeded = await seedRun(workflow, loaded, request);
  if ("error" in seeded) return seeded;
  const task = seeded;
  const settings = taskSettings(workflow, task);
  if (settings.execution === "model") return modelRunPlan(workflow, task);
  const sandbox = workflow.store.requireSandbox(task.task_id);
  workflow.harnessInstance = harnessAdapter(sandbox.harness, {
    claudeOauthToken: secrets.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null,
    anthropicApiKey: secrets.ANTHROPIC_API_KEY?.trim() || null,
  });

  const stage = workflow.stageForTask(task);
  workflow.mcpCredentialValue = mcpCredential(config, artifactCapability(stage.artifact), secrets);
  const minted = await taskCredential(workflow, task);
  const metadata = { workflow_id: "local", task_id: task.task_id, stage: stage.name };
  const routes = workflow.gatewayInstance
    ? {
        anthropic: workflow.gatewayInstance.anthropicRoute(metadata),
        compat: workflow.gatewayInstance.compatRoute(task.model, metadata),
      }
    : null;
  const kind = stage.artifact;
  const capability = artifactCapability(kind);
  const credential = artifactNeedsTaskCredential(kind, config.providers)
    ? (minted?.token ?? null)
    : await workflow.mcpCredential();
  const built = buildStartSpec({
    task,
    job: workflow.store.requireJob(task.job_id),
    sandbox,
    stage,
    effort: settings.effort,
    skills: loadHarnessSkills(settings.skill),
    harness: workflow.harness(sandbox.harness),
    providers: config.providers,
    workflowId: workflow.state.workflow_id,
    publicUrl: "",
    repo: workflow.state.repo,
    commitAuthor: workflow.state.repo ? ((await workflow.code()?.commitAuthor()) ?? null) : null,
    credential: minted?.token ?? null,
    hostEnv: cliEnv({ capability, providers: config.providers, credential, log: warn }),
    gateway: routes,
    sleepAfterMs: 0,
  });
  if ("error" in built) return built;
  if (!credential) return { error: `no credential for the ${capability} host` };

  return {
    execution: "harness",
    spec: built.spec,
    command: workflow.harness(sandbox.harness).command(task.model),
    effort: settings.effort ?? null,
    mcpServers: harnessMcpServers({
      provider: workflow.artifact(kind).mcp(credential),
      configured: config.mcp_servers,
      secret: (name) => secrets[name],
      log: warn,
    }),
    firstPrompt: firstPromptText(workflow, task),
  };
}

/** The produce activity of a model-call author, on the model the workflow builds for it. */
async function modelRunPlan(
  workflow: FakeRuntime,
  task: TaskRow,
): Promise<ModelRunPlan | { error: string }> {
  workflow.model = async (modelName, params, gatewayProvider) => {
    const { orchestratorModel } = await import("../../src/agent/model/model");
    return orchestratorModel(workflow, modelName, { params, gateway: gatewayProvider });
  };
  return produceCall(workflow, task, null).then(
    (produce) => ({ execution: "model" as const, modelName: task.model, produce }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
}

/** Seed the author task, and for a refiner the artifact and the refiner run over it. */
async function seedRun(
  workflow: FakeRuntime,
  { config, workflowDefinition }: LoadedDeploymentConfig,
  request: LocalRunRequest,
): Promise<TaskRow | { error: string }> {
  const { stages } = workflowDefinition;
  const stage = stages.find((candidate) => candidate.name === request.stage);
  if (!stage) {
    const names = stages.map((candidate) => candidate.name).join(", ");
    return { error: `no stage named ${request.stage}. The stages are: ${names}` };
  }
  const branch = stage.branch ? request.branch : null;
  if (stage.branch && (!request.repoFull || !branch)) {
    return { error: `stage ${stage.name} works on a branch. Give --repo and --branch.` };
  }
  const authorStage = resolveStage(config, stage);
  workflow.store.insertJob({
    job_id: LOCAL_JOB,
    stage: stage.name,
    issue_id: null,
    issue_key: null,
    input_key: null,
    preceding_job_id: null,
    branch,
    brief: request.brief,
  });
  workflow.store.insertTask({
    task_id: AUTHOR_TASK,
    job_id: LOCAL_JOB,
    role: "author",
    sandbox: { harness: authorStage.author.produce.harness, bridge_token: "local" },
    model: authorStage.author.produce.model,
  });
  workflow.store.updateSandbox(AUTHOR_TASK, { generation: 1 });
  if (request.role === AUTHOR_ROLE) return workflow.store.requireTask(AUTHOR_TASK);

  const refiners = [
    ...stage.reviewers.map((entry) => ({ role: "reviewer" as const, entry })),
    ...stage.polishers.map((entry) => ({ role: "polisher" as const, entry })),
  ];
  const index = refiners.findIndex((refiner) => refiner.entry.name === request.role);
  const refiner = refiners[index];
  if (!refiner) {
    const names = [AUTHOR_ROLE, ...refiners.map((candidate) => candidate.entry.name)].join(", ");
    return { error: `stage ${stage.name} has no role named ${request.role}. It has: ${names}` };
  }
  if (!request.artifactUrl) return { error: `a ${refiner.role} needs an artifact link` };
  const target = await workflow.artifact(stage.artifact).detect(request.artifactUrl);
  if (!target) {
    return { error: `the host knows no ${stage.artifact} artifact at ${request.artifactUrl}` };
  }
  workflow.store.upsertArtifact({
    job_id: LOCAL_JOB,
    kind: stage.artifact,
    external_url: target.url,
    ref: target.ref,
  });
  workflow.store.insertTask({
    task_id: REFINER_RUN,
    job_id: LOCAL_JOB,
    role: refiner.role,
    refiner_index: index,
    sandbox: {
      harness: refiner.entry.harness ?? config.orchestrator.task.harness,
      bridge_token: "local",
    },
    model: refiner.entry.model ?? config.orchestrator.task.model,
  });
  workflow.store.updateSandbox(REFINER_RUN, { generation: 1 });
  return workflow.store.requireTask(REFINER_RUN);
}

/** The deployment holds a Linear install token in D1. A local run uses the API key instead. */
function mcpCredential(
  config: Config,
  capability: McpCapability,
  secrets: LocalSecrets,
): string | null {
  if (capability === "code") return null;
  const provider = capability === "docs" ? config.providers.docs : config.providers.tracker;
  return (provider === "notion" ? secrets.NOTION_TOKEN : secrets.LINEAR_API_KEY) ?? null;
}

function codeHost(secrets: LocalSecrets): CodeHost | null {
  const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID } = secrets;
  if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_INSTALLATION_ID) return null;
  return new GithubCodeHost({
    appId: GITHUB_APP_ID,
    privateKeyPem: GITHUB_PRIVATE_KEY,
    installationId: GITHUB_INSTALLATION_ID,
  });
}

function documents(config: Config, secrets: LocalSecrets): Documents | null {
  if (config.providers.docs === "notion") {
    return secrets.NOTION_TOKEN ? new NotionDocuments(secrets.NOTION_TOKEN) : null;
  }
  return secrets.LINEAR_API_KEY ? new LinearDocuments(secrets.LINEAR_API_KEY) : null;
}

function gateway(config: Config, secrets: LocalSecrets): Gateway | null {
  const openRouterKey = secrets.OPEN_ROUTER_API_KEY || undefined;
  const { region } = config.gateways.openrouter;
  if (config.providers.gateway === "openrouter") {
    return openRouterKey ? new OpenRouterGateway({ apiKey: openRouterKey, region }) : null;
  }
  const { CF_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN } = secrets;
  if (!CF_ACCOUNT_ID || !AI_GATEWAY_ID || !AI_GATEWAY_TOKEN) return null;
  return new CloudflareGateway({
    accountId: CF_ACCOUNT_ID,
    gatewayId: AI_GATEWAY_ID,
    token: AI_GATEWAY_TOKEN,
    openRouterKey,
    openRouterRegion: region,
  });
}
