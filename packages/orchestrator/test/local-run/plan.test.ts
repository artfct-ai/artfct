import { expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config";
import { loadWorkflowDefinition } from "../../src/config/workflow-definition";
import { McpServers } from "../../src/config/mcp-servers";
import { producePagePrompt } from "../../src/prompts/model-author-prompt";
import { planLocalRun, productionConfig, type LocalRunRequest } from "./plan";

const request: LocalRunRequest = {
  stage: "plan",
  role: "author",
  artifactUrl: null,
  title: "A title",
  request: "The request text",
  brief: "",
  repoFull: null,
  branch: null,
};

test("names the stages when the stage is unknown", async () => {
  const plan = await planLocalRun({ ...request, stage: "nope" }, {});
  expect(plan).toEqual({
    error: expect.stringContaining("The stages are: architectural directions"),
  });
});

test("names the roles when the role is unknown", async () => {
  const plan = await planLocalRun({ ...request, role: "nope" }, {});
  expect(plan).toEqual({ error: expect.stringContaining("author, review") });
});

test("a refiner needs an artifact link", async () => {
  const plan = await planLocalRun({ ...request, role: "review" }, {});
  expect(plan).toEqual({ error: "a reviewer needs an artifact link" });
});

test("a branch stage needs a repository and a branch", async () => {
  const plan = await planLocalRun({ ...request, stage: "implement" }, {});
  expect(plan).toEqual({ error: expect.stringContaining("Give --repo and --branch") });
});

test("an author plan carries the production skill and first prompt", async () => {
  const plan = await planLocalRun(
    { ...request, stage: "breakdown" },
    {
      LINEAR_API_KEY: "key",
      OPEN_ROUTER_API_KEY: "key",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
    },
  );
  if ("error" in plan) throw new Error(plan.error);
  if (plan.execution !== "harness") throw new Error("the author runs as a model call");
  expect(plan.firstPrompt).toContain("The request text");
  expect(plan.spec.files.some((file) => file.path.endsWith("/breakdown/SKILL.md"))).toBe(true);
  expect(plan.mcpServers).toEqual([
    {
      type: "http",
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: [{ name: "Authorization", value: "Bearer key" }],
    },
  ]);
});

test("a harness plan adds the configured MCP servers after the provider's", async () => {
  const production = productionConfig();
  const loaded = {
    ...production,
    config: {
      ...production.config,
      mcp_servers: McpServers.parse([
        { name: "datadog", url: "https://mcp.example.com", headers: { "DD-API-KEY": "${DD_KEY}" } },
      ]),
    },
  };
  const plan = await planLocalRun(
    { ...request, stage: "breakdown" },
    {
      LINEAR_API_KEY: "key",
      OPEN_ROUTER_API_KEY: "key",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      DD_KEY: "dd-secret",
    },
    loaded,
  );
  if ("error" in plan) throw new Error(plan.error);
  if (plan.execution !== "harness") throw new Error("the author runs as a model call");
  expect(plan.mcpServers.map((server) => server.name)).toEqual(["linear", "datadog"]);
  expect(plan.mcpServers.at(-1)).toEqual({
    type: "http",
    name: "datadog",
    url: "https://mcp.example.com",
    headers: [{ name: "DD-API-KEY", value: "dd-secret" }],
  });
});

const MODEL_STAGE_CONFIG = {
  config: loadConfig(""),
  workflowDefinition: loadWorkflowDefinition(
    "development",
    [
      "description: Write one priced page.",
      "stages:",
      "  - { name: priced, artifact: page, author: { produce: { execution: model, model: openrouter/acme/writer, skill: directions } } }",
    ].join("\n"),
  ),
};

test("a model stage's author plans one model call with the production prompt", async () => {
  const plan = await planLocalRun(
    { ...request, stage: "priced" },
    {
      CF_ACCOUNT_ID: "acct",
      AI_GATEWAY_ID: "gw",
      AI_GATEWAY_TOKEN: "tok",
      OPEN_ROUTER_API_KEY: "key",
    },
    MODEL_STAGE_CONFIG,
  );
  if ("error" in plan) throw new Error(plan.error);
  if (plan.execution !== "model") throw new Error("the author runs in a harness");
  expect(plan.modelName).toBe("openrouter/acme/writer");
  expect(producePagePrompt(plan.produce.subject)).toContain("The request text");
});

test("the production design author works through its sections in the one call", async () => {
  const plan = await planLocalRun({ ...request, stage: "design" }, { OPEN_ROUTER_API_KEY: "key" });
  if ("error" in plan) throw new Error(plan.error);
  if (plan.execution !== "model") throw new Error("the author runs in a harness");
  expect(plan.modelName).toBe("openrouter/google/gemini-3.8-flash");
  expect(plan.produce.system).toContain("You write a design doc for an engineering request");
  expect(plan.produce.system).toContain("Work through them in stages, one section at a time.");
});

test("the production plan author writes the plan before the milestones that open the page", async () => {
  const plan = await planLocalRun({ ...request, stage: "plan" }, { OPEN_ROUTER_API_KEY: "key" });
  if ("error" in plan) throw new Error(plan.error);
  if (plan.execution !== "model") throw new Error("the author runs in a harness");
  expect(plan.produce.system).toContain("First write the Plan.");
  expect(plan.produce.system).toContain("The page opens with the Milestones");
});

test("a model stage's author names the secrets its gateway needs", async () => {
  const plan = await planLocalRun({ ...request, stage: "priced" }, {}, MODEL_STAGE_CONFIG);
  expect(plan).toEqual({ error: expect.stringContaining("AI_GATEWAY_TOKEN") });
});
