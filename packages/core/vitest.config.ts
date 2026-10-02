import { readDeploymentConfig } from "@artfct-ai/core/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** The D1 migrations the built package ships, applied inside the Worker by the test. */
const migrations = await readD1Migrations("./dist/migrations/d1");

/** The template's `artfct.yaml` and workflow definitions, read from source to compare with what its build inlined. */
const deploymentConfig = readDeploymentConfig("../../template/orchestrator");

/** Tests never reach the network. Every outbound fetch gets a 503. */
function offline(): Response {
  return new Response("tests are offline", { status: 503 });
}

/**
 * The template's orchestrator Worker, booted from its own config.
 * Console output is reported only for a test that fails.
 */
export default defineConfig({
  test: {
    include: ["**/*.test.medium.ts"],
    silent: "passed-only",
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../template/orchestrator/wrangler.jsonc" },
      miniflare: {
        outboundService: offline,
        bindings: { TEST_MIGRATIONS: migrations, TEST_DEPLOYMENT_CONFIG: deploymentConfig },
      },
    }),
  ],
});
