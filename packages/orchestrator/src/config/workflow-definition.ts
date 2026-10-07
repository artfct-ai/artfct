import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SkillRef } from "./skill-frontmatter";
import { Stage } from "./stage";

/** Settings for the documents a workflow writes, across its stages. */
const WorkflowDocuments = z.strictObject({
  /**
   * Where the pages of this kind of work go when the request names no place. A link to a page,
   * or to a database, on a document host that nests pages.
   */
  page_parent: z.string().trim().min(1).optional(),
  /** The stage whose page is the root page, on a document host that nests pages. */
  root_page: z.string().trim().min(1).optional(),
});

const ROOT_PAGE_PATH = ["documents", "root_page"];

/** The keys of a workflow definition file. An unknown key fails. */
const WorkflowDefinitionFile = z
  .strictObject({
    /** What kind of work the definition is for. The orchestrator agent reads it. */
    description: z.string().trim().min(1),
    documents: WorkflowDocuments.prefault({}),
    /** The stages in order. A task reads the one its job runs. */
    stages: z.array(Stage).min(1),
  })
  .superRefine((file, context) => {
    const { root_page } = file.documents;
    if (root_page === undefined) return;
    const stage = file.stages.find((declared) => declared.name === root_page);
    if (!stage) {
      context.addIssue({
        code: "custom",
        message: `documents.root_page names ${root_page}, which is not a stage of this workflow definition`,
        path: ROOT_PAGE_PATH,
      });
      return;
    }
    if (stage.artifact !== "page") {
      context.addIssue({
        code: "custom",
        message: `documents.root_page names ${root_page}, which does not produce a page`,
        path: ROOT_PAGE_PATH,
      });
      return;
    }
    if (stage.author.produce.execution !== "model" || stage.polishers.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "the root page stage needs a model-call author and no polishers. A harness rewrites the whole page, and the root page keeps its resources section.",
        path: ROOT_PAGE_PATH,
      });
    }
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
