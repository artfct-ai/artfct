import { cpSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { rolldown } from "rolldown";
import { dts } from "rolldown-plugin-dts";
import manifest from "../package.json";
import { bundledDependencies, type Manifest } from "./bundled-dependencies";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const REPO_DIR = join(PACKAGE_DIR, "../..");
const DIST = join(PACKAGE_DIR, "dist");
const D1_MIGRATIONS = join(REPO_DIR, "packages/orchestrator/migrations/d1");
const SANDBOX_DOCKERFILE = "packages/orchestrator/sandbox/Dockerfile";
/** The files the sandbox Dockerfile copies, at their paths under the repository root. */
const SANDBOX_CONTEXT_FILES = [
  "packages/sandbox-bridge/dist/artfct-bridge",
  "packages/orchestrator/sandbox/NOTICES.md",
  "packages/orchestrator/sandbox/agents/package.json",
  "packages/orchestrator/sandbox/agents/package-lock.json",
  "LICENSE",
  "NOTICE",
];

const PUBLISHED_SANDBOX_IMAGE = "docker.io/artfct/sandbox";
/** The tag and digest of the sandbox image CI published for this build. Both unset in a build that publishes none. */
const publishedImageTag = process.env.SANDBOX_IMAGE_TAG;
const publishedImageDigest = process.env.SANDBOX_IMAGE_DIGEST;
if ((publishedImageTag === undefined) !== (publishedImageDigest === undefined)) {
  console.error("SANDBOX_IMAGE_TAG and SANDBOX_IMAGE_DIGEST must be set together");
  process.exit(1);
}
if (publishedImageDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(publishedImageDigest)) {
  console.error("SANDBOX_IMAGE_DIGEST must be sha256: followed by 64 hex digits");
  process.exit(1);
}

const workspace = await Promise.all(
  [...new Bun.Glob("packages/*/package.json").scanSync(REPO_DIR)].map((path): Promise<Manifest> =>
    Bun.file(join(REPO_DIR, path)).json(),
  ),
);
const bundled = Object.entries(manifest.devDependencies)
  .filter(([, range]) => range.startsWith("workspace:"))
  .map(([name]) => name);
const expected = bundledDependencies(workspace, bundled);
if (JSON.stringify(expected) !== JSON.stringify(manifest.dependencies)) {
  console.error("dependencies must list the bundled workspace packages' npm dependencies:");
  console.error(JSON.stringify(expected, null, 2));
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });

const entrypoints = ["orchestrator", "ingress", "durable-objects", "config"].map((entry) =>
  join(PACKAGE_DIR, "src", `${entry}.ts`),
);
const result = await Bun.build({
  entrypoints,
  root: join(PACKAGE_DIR, "src"),
  outdir: DIST,
  target: "browser",
  format: "esm",
  splitting: true,
  external: ["cloudflare:*", "node:*", ...Object.keys(manifest.dependencies)],
  loader: { ".sql": "text" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const declarations = await rolldown({
  cwd: PACKAGE_DIR,
  input: entrypoints,
  external: (id) =>
    /^(cloudflare|node):/.test(id) ||
    Object.keys(manifest.dependencies).some(
      (dependency) => id === dependency || id.startsWith(`${dependency}/`),
    ),
  plugins: [dts({ emitDtsOnly: true, tsconfig: join(REPO_DIR, "tsconfig.declarations.json") })],
});
await declarations.write({ dir: DIST, format: "esm" });

cpSync(D1_MIGRATIONS, join(DIST, "migrations/d1"), {
  recursive: true,
  filter: (source) => !relative(D1_MIGRATIONS, source).startsWith("meta"),
});
for (const file of ["LICENSE", "NOTICE"]) cpSync(join(REPO_DIR, file), join(DIST, file));
cpSync(join(REPO_DIR, SANDBOX_DOCKERFILE), join(DIST, "sandbox/Dockerfile"));
for (const path of SANDBOX_CONTEXT_FILES) cpSync(join(REPO_DIR, path), join(DIST, "sandbox", path));
if (publishedImageTag !== undefined && publishedImageDigest !== undefined) {
  await Bun.write(
    join(DIST, "sandbox/published-image"),
    `${PUBLISHED_SANDBOX_IMAGE}:${publishedImageTag}@${publishedImageDigest}\n`,
  );
}
