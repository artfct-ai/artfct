import { builtinModules } from "node:module";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testVars } from "./test/test-env.ts";

/** D1 migrations are read here in Node and applied inside the Worker by `vitest.setup.ts`. */
const migrations = await readD1Migrations("./migrations/d1");

/** Tests never reach the network. Every outbound fetch gets a 503. */
function offline(): Response {
  return new Response("tests are offline", { status: 503 });
}

/**
 * Vendor packages the Worker entrypoint loads, prebundled so each test isolate fetches a few
 * modules instead of hundreds. Every subpath is listed by hand, and a package that only a
 * workspace package depends on is named through that package.
 */
const PREBUNDLED_VENDORS = [
  "ai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/provider",
  "zod",
  "drizzle-orm",
  "drizzle-orm/d1",
  "drizzle-orm/sqlite-core",
  "drizzle-orm/durable-sqlite",
  "drizzle-orm/durable-sqlite/migrator",
  "@agentclientprotocol/sdk",
  "agents",
  "agents/observability/ai",
  "@cloudflare/sandbox",
  "yaml",
  "@artfct-ai/adapters > @octokit/rest",
  "@artfct-ai/adapters > @octokit/auth-app",
];

/** Console output from the Worker is reported only for a test that fails. */
export default defineConfig({
  test: {
    include: ["**/*.test.medium.ts"],
    silent: "passed-only",
    setupFiles: ["./vitest.setup.ts"],
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: PREBUNDLED_VENDORS,
          rolldownOptions: { external: [/^cloudflare:/, /^node:/, ...builtinModules] },
        },
      },
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        outboundService: offline,
        bindings: { ...testVars(), TEST_MIGRATIONS: migrations },
      },
    }),
  ],
});
