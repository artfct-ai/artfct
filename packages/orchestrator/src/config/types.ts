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

/** The parsed `artfct.yaml` of a deployment and its one workflow definition. */
export type LoadedDeploymentConfig = { config: Config; workflowDefinition: WorkflowDefinition };

/** The config the Worker runs on: the parsed settings and workflow definition, the writing rules, and the skills. */
export type RegisteredConfig = LoadedDeploymentConfig & { writingRules: string; skills: Skill[] };
