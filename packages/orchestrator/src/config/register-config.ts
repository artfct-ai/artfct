import { loadConfig } from "./config";
import type { ConfigFiles, LoadedDeploymentConfig, RegisteredConfig } from "./types";
import { loadWorkflowDefinition } from "./workflow-definition";

let registered: RegisteredConfig | null = null;

function parseFile<Parsed>(file: string, parse: () => Parsed): Parsed {
  try {
    return parse();
  } catch (error) {
    throw new Error(`${file} breaks the config schema`, { cause: error });
  }
}

/**
 * Parse `artfct.yaml` and the workflow definitions of a deployment. Throws on a file the schema
 * refuses, and unless there is exactly one workflow definition.
 */
export function loadDeploymentConfig(
  files: Pick<ConfigFiles, "config" | "workflowDefinitions">,
): LoadedDeploymentConfig {
  const config = parseFile("artfct.yaml", () => loadConfig(files.config));
  const definitions = files.workflowDefinitions.map(({ name, text }) =>
    parseFile(`workflows/${name}.yaml`, () => loadWorkflowDefinition(name, text)),
  );
  const [workflowDefinition, ...others] = definitions;
  if (!workflowDefinition) {
    throw new Error("the deployment has no workflow definition. Add one as workflows/<name>.yaml");
  }
  if (others.length > 0) {
    const names = definitions.map((definition) => definition.name).join(", ");
    throw new Error(
      `the deployment has ${definitions.length} workflow definitions (${names}). Multiple workflow definitions are not supported yet. Keep one`,
    );
  }
  if (workflowDefinition.page_parent && config.adapters.documents.provider === "linear") {
    throw new Error(
      `workflows/${workflowDefinition.name}.yaml sets page_parent, which is for a document host that nests pages. Linear puts the documents of a workflow in the project of its issue, or the agent asks`,
    );
  }
  return { config, workflowDefinition };
}

/** Registers the config files the build inlined into the Worker entrypoint. Call it before any request. */
export function registerConfig(files: ConfigFiles): void {
  registered = {
    ...loadDeploymentConfig(files),
    writingRules: files.writingRules,
    skills: files.skills,
  };
}

/** The config the Worker entrypoint registered. */
export function registeredConfig(): RegisteredConfig {
  if (!registered) {
    throw new Error(
      "the config is not registered. The Worker entrypoint passes its config files to registerConfig",
    );
  }
  return registered;
}
