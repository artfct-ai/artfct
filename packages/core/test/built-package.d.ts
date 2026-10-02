declare module "@artfct-ai/core/orchestrator" {
  export { default } from "@artfct-ai/orchestrator";
  export { registerConfig } from "@artfct-ai/orchestrator/config/register-config";
}

declare module "@artfct-ai/core/ingress" {
  export { default } from "@artfct-ai/ingress";
}

declare module "@artfct-ai/core/durable-objects" {
  export { Workflow } from "@artfct-ai/orchestrator/workflow";
  export { Sandbox } from "@cloudflare/sandbox";
}

declare module "@artfct-ai/core/config" {
  export { Config, loadConfig } from "@artfct-ai/orchestrator/config/config";
  export { loadDeploymentConfig } from "@artfct-ai/orchestrator/config/register-config";
  export { loadWorkflowDefinition } from "@artfct-ai/orchestrator/config/workflow-definition";
  export {
    parseSkillName,
    SKILL_ENTRY,
    SkillFrontmatter,
  } from "@artfct-ai/orchestrator/config/skill-frontmatter";
  export {
    compileConfig,
    compileSkill,
    listSkillEntries,
    readDeploymentConfig,
  } from "@artfct-ai/orchestrator/config/compile-config";
}

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_DEPLOYMENT_CONFIG: ReturnType<
      typeof import("@artfct-ai/core/config").readDeploymentConfig
    >;
  }
}
