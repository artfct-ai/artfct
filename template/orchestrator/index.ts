import { registerConfig } from "@artfct-ai/core/orchestrator";

/** The config files of this directory. The build inlines them. */
declare const CONFIG: Parameters<typeof registerConfig>[0];

registerConfig(CONFIG);

export { default } from "@artfct-ai/core/orchestrator";
export { Sandbox, SandboxLarge, Workflow } from "@artfct-ai/core/durable-objects";
