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

  describe("a workflow definition with a default page parent", () => {
    const LINK = "https://www.notion.so/acme/Design-docs-3eb92fd781108088b848ebb16c8f4838";
    const withPageParent = `documents: { page_parent: "${LINK}" }\n${DEFINITION}`;

    it("keeps it on a document host that nests pages", () => {
      const loaded = loadDeploymentConfig({
        config: "adapters: { documents: { provider: notion } }",
        workflowDefinitions: [{ name: "development", text: withPageParent }],
      });
      expect(loaded.workflowDefinition.documents.page_parent).toBe(LINK);
    });

    it("is unset when the workflow definition names none", () => {
      const loaded = loadDeploymentConfig({
        config: "",
        workflowDefinitions: [{ name: "development", text: DEFINITION }],
      });
      expect(loaded.workflowDefinition.documents.page_parent).toBeUndefined();
    });

    it("refuses it on Linear, where the issue's project holds the documents", () => {
      expect(() =>
        loadDeploymentConfig({
          config: "",
          workflowDefinitions: [{ name: "development", text: withPageParent }],
        }),
      ).toThrow(/workflows\/development\.yaml sets documents\.page_parent/);
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
