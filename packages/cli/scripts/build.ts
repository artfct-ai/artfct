import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import manifest from "../package.json";
import { packageTemplate } from "../src/init/packaged-template";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const DIST = join(PACKAGE_DIR, "dist");

rmSync(DIST, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(PACKAGE_DIR, "src/artfct.ts")],
  outdir: DIST,
  target: "node",
  format: "esm",
  external: [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const file of ["LICENSE", "NOTICE"])
  cpSync(join(PACKAGE_DIR, "../..", file), join(DIST, file));

packageTemplate(join(PACKAGE_DIR, "../../template"), join(DIST, "template"));
