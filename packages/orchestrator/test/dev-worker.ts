import { registerConfig } from "../src/config/register-config";
import { envSecret, type Env } from "../src/env";
import {
  defaultServices,
  Workflow as DeployedWorkflow,
  type WorkflowServices,
} from "../src/workflow";
import templateConfig from "./template-config.json";
import { MockSandboxProvider } from "./mock-sandbox-provider";

export { default, Sandbox, SandboxLarge } from "../src/index";

registerConfig(templateConfig);

/** The URL of the local sandbox host, `scripts/mock-sandbox.ts`. */
function mockSandboxUrl(env: Env): string {
  const url = envSecret(env, "MOCK_SANDBOX_URL");
  if (!url) throw new Error("MOCK_SANDBOX_URL is required");
  return url;
}

/** The services of `bun run dev`: real models, and sandboxes on the local host. */
export const devServices: WorkflowServices = {
  ...defaultServices,
  sandbox: (env) => new MockSandboxProvider(mockSandboxUrl(env)),
};

/** The Workflow of `bun run dev`. */
export class Workflow extends DeployedWorkflow {
  override services: WorkflowServices = { ...devServices };
}
