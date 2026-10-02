import type { ConfigFiles } from "../src/config/types";
import templateConfig from "./template-config.json";

/** The workflow definition of tests: the default stages, one reviewer each. */
const TEST_WORKFLOW_DEFINITION = [
  "description: Take a request from design through pull requests.",
  "stages:",
  "  - { name: design, artifact: page, author: { produce: { execution: harness, skill: design } }, reviewers: [ { name: Code review, skill: design-review } ] }",
  "  - { name: breakdown, artifact: issues, author: { produce: { execution: harness, skill: breakdown } }, reviewers: [ { name: Code review, skill: breakdown-review } ] }",
  "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } }, reviewers: [ { name: Code review, skill: implement-review } ] }",
].join("\n");

/**
 * The config tests run on: the template's writing rules and skills, every config default, and
 * the test workflow definition.
 */
export const TEST_CONFIG: ConfigFiles = {
  ...templateConfig,
  config: "",
  workflowDefinitions: [{ name: "development", text: TEST_WORKFLOW_DEFINITION }],
};
