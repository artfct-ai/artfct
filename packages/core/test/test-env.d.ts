declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_DEPLOYMENT_CONFIG: ReturnType<
      typeof import("@artfct-ai/core/config").readDeploymentConfig
    >;
  }
}
