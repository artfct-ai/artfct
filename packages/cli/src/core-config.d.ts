declare module "@artfct-ai/core/config" {
  export { loadConfig } from "@artfct-ai/orchestrator/config/config";
  export { loadDeploymentConfig } from "@artfct-ai/orchestrator/config/register-config";
  export {
    compileSkill,
    listSkillEntries,
    readDeploymentConfig,
  } from "@artfct-ai/orchestrator/config/compile-config";
}
