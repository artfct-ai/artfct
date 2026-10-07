import { describe, expect, it } from "bun:test";
import { loadDeploymentConfig } from "./register-config";

const DEFINITION = [
  "description: Take a request from design through pull requests.",
  "stages:",
  "  - { name: implement, artifact: pull, author: { produce: { execution: harness, skill: implement } } }",
].join("\n");

describe("loadDeploymentConfig", () => {
  describe("a deployment with one workflow definition", () => {
    const loaded = loadDeploymentConfig({
      config: "adapters: { documents: { provider: notion } }",
      workflowDefinitions: [{ name: "development", text: DEFINITION }],
    });

    it("parses the settings", () => {
      expect(loaded.config.adapters.documents.provider).toBe("notion");
    });

    it("parses the workflow definition under its name", () => {
      expect(loaded.workflowDefinition.name).toBe("development");
    });
  });

  it("refuses a deployment without a workflow definition", () => {
    expect(() => loadDeploymentConfig({ config: "", workflowDefinitions: [] })).toThrow(
      /no workflow definition\. Add one as workflows\/<name>\.yaml/,
    );
  });

  it("refuses a second workflow definition", () => {
    expect(() =>
      loadDeploymentConfig({
        config: "",
        workflowDefinitions: [
          { name: "development", text: DEFINITION },
          { name: "incident", text: DEFINITION },
        ],
      }),
    ).toThrow(
      /2 workflow definitions \(development, incident\)\. Multiple workflow definitions are not supported yet/,
    );
  });

  it("names artfct.yaml when the settings break the schema, and keeps the schema error", () => {
    expect(() =>
      loadDeploymentConfig({
        config: DEFINITION,
        workflowDefinitions: [{ name: "development", text: DEFINITION }],
      }),
    ).toThrow(
      expect.objectContaining({
        message: "artfct.yaml breaks the config schema",
        cause: expect.objectContaining({ name: "ZodError" }),
      }),
    );
  });

  it("names the workflow definition file that breaks the schema", () => {
    expect(() =>
      loadDeploymentConfig({
        config: "",
        workflowDefinitions: [{ name: "development", text: "stages: []" }],
      }),
    ).toThrow("workflows/development.yaml breaks the config schema");
  });
});
