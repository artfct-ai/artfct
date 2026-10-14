import type { Skill } from "@artfct-ai/adapters/harness/types";
import type { Config } from "./config";
import type { WorkflowDefinition } from "./workflow-definition";

/**
 * The config files of a deployment as text: `artfct.yaml`, the name and text of each workflow
 * definition, the writing rules, and the skills.
 */
export type ConfigFiles = {
  config: string;
  workflowDefinitions: { name: string; text: string }[];
  writingRules: string;
  skills: Skill[];
};

/** The parsed `artfct.yaml` of a deployment and its workflow definitions. */
export type LoadedDeploymentConfig = { config: Config; workflowDefinitions: WorkflowDefinition[] };

/** The config the Worker runs on: the parsed settings and workflow definitions, the writing rules, and the skills. */
export type RegisteredConfig = LoadedDeploymentConfig & { writingRules: string; skills: Skill[] };
