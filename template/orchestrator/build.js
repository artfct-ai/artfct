import { join } from "node:path";
import { compileConfig } from "@artfct-ai/core/config";
import { build } from "esbuild";

const orchestratorDir = import.meta.dirname;

await build({
  entryPoints: [join(orchestratorDir, "index.ts")],
  outfile: join(orchestratorDir, "dist/index.js"),
  bundle: true,
  packages: "external",
  format: "esm",
  define: { CONFIG: JSON.stringify(compileConfig(orchestratorDir)) },
});
