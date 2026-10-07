import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflowDefinition } from "./workflow-definition";

const DESCRIPTION = "description: Take a request from design through pull requests.";

const MINIMAL_YAML = `${DESCRIPTION}
stages:
  - name: implement
    artifact: pull
    branch: true
    author:
      produce:
        execution: harness
        skill: implement
`;

function definitionWithStages(stages: string) {
  return loadWorkflowDefinition("development", `${DESCRIPTION}\nstages:\n${stages}`);
}

function definitionWithRootPage(rootPage: string, stages: string) {
  return loadWorkflowDefinition(
    "development",
    `${DESCRIPTION}\ndocuments: { root_page: ${rootPage} }\nstages:\n${stages}`,
  );
}

describe("loadWorkflowDefinition", () => {
  describe("a definition with one stage", () => {
    const definition = loadWorkflowDefinition("development", MINIMAL_YAML);

    it("carries the name it was loaded under", () => {
      expect(definition.name).toBe("development");
    });

    it("keeps the description", () => {
      expect(definition.description).toBe("Take a request from design through pull requests.");
    });

    it("keeps the stage", () => {
      expect(definition.stages.map((stage) => stage.name)).toEqual(["implement"]);
    });
  });

  describe("a stage that sets values of its own", () => {
    const definition = definitionWithStages(`
  - name: plan
    artifact: page
    author:
      produce:
        execution: harness
        model: custom-model
        effort: low
        skill: plan
`);

    it("keeps the author's model", () => {
      expect(definition.stages[0]?.author.produce.model).toBe("custom-model");
    });

    it("keeps the author's effort", () => {
      expect(definition.stages[0]?.author.produce.effort).toBe("low");
    });

    it("leaves the stage without its own branch", () => {
      expect(definition.stages[0]?.branch).toBe(false);
    });
  });

  describe("a stage with a research step", () => {
    const definition = definitionWithStages(`
  - name: design
    artifact: page
    author:
      produce:
        execution: harness
        skill: design
    research:
      skill: research
      harness: opencode
      model: research-model
      effort: high
  - name: implement
    artifact: pull
    author:
      produce:
        execution: harness
        skill: implement
`);

    it("reads the research step", () => {
      expect(definition.stages[0]?.research).toEqual({
        skill: "research",
        harness: "opencode",
        model: "research-model",
        effort: "high",
      });
    });

    it("leaves a stage without one with none", () => {
      expect(definition.stages[1]?.research).toBeUndefined();
    });
  });

  describe("a stage condition", () => {
    it("keeps the sentence as written", () => {
      const definition = definitionWithStages(`
  - name: breakdown
    artifact: issues
    author:
      produce:
        execution: harness
        skill: breakdown
    when: the plan needs more than one pull request
`);
      expect(definition.stages[0]?.when).toBe("the plan needs more than one pull request");
    });

    it("stays unset on a stage that names none, so the stage always runs", () => {
      expect(loadWorkflowDefinition("development", MINIMAL_YAML).stages[0]?.when).toBeUndefined();
    });
  });

  describe("a model-call author", () => {
    it("takes a stage with model execution", () => {
      const definition = definitionWithStages(
        "  - { name: design, artifact: page, author: { produce: { execution: model, skill: design, model: openrouter/x-ai/grok-4.6 } } }",
      );
      expect(definition.stages[0]?.author.produce.execution).toBe("model");
    });

    it("refuses an author activity with model execution and no model", () => {
      expect(() =>
        definitionWithStages(
          "  - { name: design, artifact: page, author: { produce: { execution: model, skill: design } } }",
        ),
      ).toThrow();
    });
  });

  describe("a root page stage", () => {
    const MODEL_PAGE =
      "artifact: page, author: { produce: { execution: model, skill: design, model: openrouter/x-ai/grok-4.6 } }";

    it("names the stage whose page is the root page", () => {
      const definition = definitionWithRootPage(
        "design",
        `  - { name: design, ${MODEL_PAGE} }\n  - { name: plan, ${MODEL_PAGE} }`,
      );
      expect(definition.documents.root_page).toBe("design");
    });

    it("is unset when the definition names none", () => {
      expect(
        loadWorkflowDefinition("development", MINIMAL_YAML).documents.root_page,
      ).toBeUndefined();
    });

    it("refuses a stage the definition does not have", () => {
      expect(() =>
        definitionWithRootPage("overview", `  - { name: design, ${MODEL_PAGE} }`),
      ).toThrow(/documents\.root_page names overview, which is not a stage/);
    });

    it("refuses a root page stage that produces no page", () => {
      expect(() =>
        definitionWithRootPage(
          "x",
          "  - { name: x, artifact: pull, author: { produce: { execution: harness, skill: implement } } }",
        ),
      ).toThrow(/documents\.root_page names x, which does not produce a page/);
    });

    it("refuses a root page stage whose author runs in a harness", () => {
      expect(() =>
        definitionWithRootPage(
          "design",
          "  - { name: design, artifact: page, author: { produce: { execution: harness, skill: design } } }",
        ),
      ).toThrow(/model-call author/);
    });
  });

  it("takes an author skill no file carries yet, which the task start reports", () => {
    const definition = definitionWithStages(
      "  - { name: x, artifact: pull, author: { produce: { execution: harness, skill: invent-it } } }",
    );
    expect(definition.stages[0]?.author.produce.skill).toBe("invent-it");
  });

  describe("a definition the schema refuses", () => {
    it("wants at least one stage", () => {
      expect(() => loadWorkflowDefinition("development", `${DESCRIPTION}\nstages: []`)).toThrow();
    });

    it("wants a stages key", () => {
      expect(() => loadWorkflowDefinition("development", DESCRIPTION)).toThrow(/stages/);
    });

    it("wants a description", () => {
      expect(() =>
        loadWorkflowDefinition("development", MINIMAL_YAML.replace(DESCRIPTION, "")),
      ).toThrow(/description/);
    });

    it("wants a description with words in it", () => {
      expect(() =>
        loadWorkflowDefinition(
          "development",
          MINIMAL_YAML.replace(DESCRIPTION, 'description: " "'),
        ),
      ).toThrow(/description/);
    });

    it("rejects a key it does not know, such as a deployment setting", () => {
      expect(() =>
        loadWorkflowDefinition("development", `defaults: { harness: opencode }\n${MINIMAL_YAML}`),
      ).toThrow(/defaults/);
    });

    it("rejects a name no file can be named after", () => {
      expect(() => loadWorkflowDefinition("Incident Response", MINIMAL_YAML)).toThrow();
    });

    it("rejects an artifact type it does not know", () => {
      expect(() =>
        definitionWithStages(
          "  - { name: x, artifact: pdf, author: { produce: { execution: harness, skill: implement } } }",
        ),
      ).toThrow();
    });

    it("rejects an author skill no file can be named after", () => {
      expect(() =>
        definitionWithStages(
          "  - { name: x, artifact: pull, author: { produce: { execution: harness, skill: ../../secrets } } }",
        ),
      ).toThrow();
    });

    it("rejects a reviewer skill no file can be named after", () => {
      expect(() =>
        definitionWithStages(
          "  - { name: x, artifact: pull, author: { produce: { execution: harness, skill: implement } }, reviewers: [ { name: review, skill: Invent It } ] }",
        ),
      ).toThrow();
    });
  });
});

describe("the template workflow definition", () => {
  it("parses", () => {
    const text = readFileSync(
      join(import.meta.dirname, "../../../../template/orchestrator/workflows/development.yaml"),
      "utf8",
    );
    expect(loadWorkflowDefinition("development", text).stages.length).toBeGreaterThan(0);
  });
});
