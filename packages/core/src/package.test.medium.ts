import Orchestrator from "@artfct-ai/core/orchestrator";
import { loadDeploymentConfig, loadWorkflowDefinition } from "@artfct-ai/core/config";
import { Sandbox, Workflow } from "@artfct-ai/core/durable-objects";
import { runInDurableObject } from "cloudflare:test";
import { DurableObject, env, exports, WorkerEntrypoint } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import ingress from "../../../template/ingress/index";

beforeAll(async () => {
  const statements = env.TEST_MIGRATIONS.flatMap((migration) =>
    migration.queries.map((sql) => env.DB.prepare(sql)),
  );
  await env.DB.batch(statements);
});

describe("the template Workers on the built artfct package", () => {
  describe("the orchestrator entrypoint", () => {
    it("is a Worker entrypoint", () => {
      expect(Orchestrator.prototype).toBeInstanceOf(WorkerEntrypoint);
    });

    it("answers the template Worker's fetch", async () => {
      const response = await exports.default.fetch("https://orchestrator.test/");
      expect(await response.text()).toBe("artfct-orchestrator");
    });
  });

  describe("the ingress entrypoint", () => {
    it("answers its health check", async () => {
      const response = await ingress.request("/healthz");
      expect(await response.text()).toBe("ok");
    });
  });

  describe("the Durable Object classes", () => {
    it("export a Sandbox Durable Object", () => {
      expect(Sandbox.prototype).toBeInstanceOf(DurableObject);
    });

    it("start a Workflow on the bundled migrations", async () => {
      const stub = env.Workflow.getByName("wf_package");
      await stub.status();
      await runInDurableObject(stub, (instance, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((row) => row.name);
        const applied = state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM __drizzle_migrations")
          .one().count;
        expect(instance).toBeInstanceOf(Workflow);
        expect(tables).toEqual(expect.arrayContaining(["jobs", "tasks", "outbox"]));
        expect(applied).toBeGreaterThan(0);
      });
    });

    it("starts a Workflow on the config the entrypoint registered", async () => {
      const stub = env.Workflow.getByName("wf_config");
      await stub.status();
      await runInDurableObject(stub, (instance: Workflow) => {
        expect(instance.workflowDefinition()).toEqual(
          loadDeploymentConfig(env.TEST_DEPLOYMENT_CONFIG).workflowDefinition,
        );
      });
    });
  });

  describe("the config export", () => {
    it("parses a workflow definition", () => {
      const definition = loadWorkflowDefinition(
        "development",
        "description: Write designs.\nstages:\n  - { name: design, artifact: page, author: { produce: { execution: harness, skill: design } } }",
      );
      expect(definition.stages.map((stage) => stage.name)).toEqual(["design"]);
    });
  });
});
