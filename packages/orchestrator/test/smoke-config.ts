import { PR_STAGE } from "../../../packages/bridge/test/mock-harness-turn";
import type { ConfigFiles } from "../src/config/types";
import templateConfig from "./template-config.json";

/** The document stages of the smoke workflow, in order. Each one produces a Notion page. */
export const DOC_STAGES = ["design", "directions", "breakdown"];

/** The document stage whose page a reviewer reads before the humans hear about it. */
export const REVIEWED_DOC_STAGE = "design";

/**
 * The document stage that runs a research step, runs its author as one call to the scripted
 * model, and ends on a choice.
 */
export const MODEL_DOC_STAGE = "directions";

/**
 * The reviewer entries of the PR stage, in list order. All three are findings entries in one
 * segment, so the mock flow crosses two mid-segment hand-ons. The mock flow has no decisions
 * model, so it has no judge entry.
 */
export const PR_REVIEWERS = ["alignment", "review", "final"];

/** The polisher entries of the PR stage. They run once the reviewers settle. */
export const PR_POLISHERS = ["comments"];

/** The last stage. It is the one the mock harness opens a PR for. */
export const PR_STAGE_NAME = PR_STAGE;

/** Harness and model every smoke task runs with. */
export const STAGE_HARNESS = "opencode";
export const STAGE_MODEL = "mock-model";

/** The settings of a document stage beyond its name and artifact. */
function docStageSettings(stage: string): string {
  if (stage === REVIEWED_DOC_STAGE) {
    return `author: { produce: { execution: harness, skill: ${stage} } }, reviewers: [ { name: review, skill: design-review } ]`;
  }
  if (stage === MODEL_DOC_STAGE) {
    return `author: { produce: { execution: model, model: ${STAGE_MODEL}, skill: ${stage} } }, reviewers: [], research: { skill: research }, ending: choice`;
  }
  return `author: { produce: { execution: harness, skill: ${stage} } }, reviewers: []`;
}

const SMOKE_SETTINGS = [
  "orchestrator:",
  "  task:",
  `    harness: ${STAGE_HARNESS}`,
  `    model: ${STAGE_MODEL}`,
  "    timeouts: { no_progress_minutes: 5, time_elapsed_minutes: 60 }",
  "providers: { docs: notion }",
].join("\n");

/**
 * Four stages. One document stage is reviewed. One runs a research step and a model-call author
 * and ends on a choice. The third is neither, and reads the selection. Only the PR stage declares
 * polishers, so the run crosses the reviewer to polisher hand-on.
 */
function smokeWorkflowDefinition(): string {
  const docStages = DOC_STAGES.map(
    (stage) => `  - { name: ${stage}, artifact: page, ${docStageSettings(stage)} }`,
  );
  const prReviewers = PR_REVIEWERS.map((name) => `{ name: ${name}, skill: implement-review }`).join(
    ", ",
  );
  const prPolishers = PR_POLISHERS.map((name) => `{ name: ${name}, skill: technical-writer }`).join(
    ", ",
  );
  return [
    "description: Take a request from design through pull requests.",
    "stages:",
    ...docStages,
    `  - { name: ${PR_STAGE_NAME}, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } }, reviewers: [ ${prReviewers} ], polishers: [ ${prPolishers} ] }`,
  ].join("\n");
}

/** The config of the smoke run: the template's writing rules and skills, and the smoke stages. */
export const SMOKE_CONFIG: ConfigFiles = {
  ...templateConfig,
  config: SMOKE_SETTINGS,
  workflowDefinitions: [{ name: "development", text: smokeWorkflowDefinition() }],
};
