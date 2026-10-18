import { defineConfig } from "vitest/config";
import mediumConfig from "./vitest.config.ts";

/**
 * The medium test config, narrowed to the spec replays that only the `spec:replay` task runs.
 * It skips the vendor prebundle, which parallel replay processes would race to write.
 */
export default defineConfig({
  ...mediumConfig,
  test: {
    ...mediumConfig.test,
    include: ["**/*.replay.medium.ts"],
    deps: { optimizer: { ssr: { enabled: false } } },
  },
});
