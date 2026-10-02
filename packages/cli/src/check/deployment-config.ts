import { loadDeploymentConfig, readDeploymentConfig } from "@artfct-ai/core/config";
import type { CheckOutcome } from "./types";

/**
 * Validate the orchestrator's `artfct.yaml` and its workflow definitions together, against the config
 * schema of the installed artfct.
 */
export function checkDeploymentConfig(configDir: string): CheckOutcome {
  const { workflowDefinition } = loadDeploymentConfig(readDeploymentConfig(configDir));
  const { name, stages } = workflowDefinition;
  return { outcome: "passed", detail: `workflow definition ${name} with ${stages.length} stages` };
}
