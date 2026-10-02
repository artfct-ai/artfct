import type { Decisions } from "@artfct-ai/adapters/gateway/types";
import { registerConfig } from "../src/config/register-config";
import type { WorkflowServices } from "../src/workflow";
import { devServices, Workflow as DevWorkflow } from "./dev-worker";
import { ScriptedDecisions } from "./scripted-decisions";
import { ScriptedModel } from "./scripted-model";
import { TEST_CONFIG } from "./test-config";

export { default, Sandbox, SandboxLarge } from "../src/index";

registerConfig(TEST_CONFIG);

/** The services of the workerd tests: the dev services with every model scripted. */
export const testServices: WorkflowServices = {
  ...devServices,
  model: async () => new ScriptedModel(),
};

/** The Workflow of the workerd tests. Every model and decision is scripted. */
export class Workflow extends DevWorkflow {
  override services: WorkflowServices = { ...testServices };

  override decisions(): Decisions {
    return new ScriptedDecisions();
  }
}
