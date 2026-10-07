import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SkillRef } from "./skill-frontmatter";
import { Stage } from "./stage";

/** The two keys of a workflow definition file. An unknown key fails. */
const WorkflowDefinitionFile = z.strictObject({
  /** What kind of work the definition is for. The orchestrator agent reads it. */
  description: z.string().trim().min(1),
  /** The stages in order. A task reads the one its job runs. */
  stages: z
    .array(Stage)
    .min(1)
    .refine((stages) => stages.filter((stage) => stage.root_page).length <= 1, {
      message: "one stage at most sets root_page. A workflow has one root page.",
    }),
});

/** A named set of stages in config. A workflow runs one. */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionFile> & { name: string };

/**
 * Parse one workflow definition. The name is its file name under `workflows` without `.yaml`,
 * and follows the rules of a skill name.
 */
export function loadWorkflowDefinition(name: string, yamlText: string): WorkflowDefinition {
  return { name: SkillRef.parse(name), ...WorkflowDefinitionFile.parse(parseYaml(yamlText)) };
}
