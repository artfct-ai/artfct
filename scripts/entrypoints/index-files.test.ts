import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../..");
const BUILD_OUTPUT = /(^|\/)(node_modules|dist|\.wrangler)\//;
const WORKER_DEFAULT_EXPORT = /^export (default |\{[^}]*\bdefault\b[^}]*\} from )/m;
const INDEX_PATTERNS = [
  "packages/*/{src,test,scripts}/**/index.ts",
  "template/**/index.ts",
  "scripts/**/index.ts",
];

function indexFiles(): string[] {
  return INDEX_PATTERNS.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT }),
  ])
    .filter((path) => !BUILD_OUTPUT.test(path))
    .toSorted();
}

describe("index.ts", () => {
  const files = indexFiles();

  it("finds the Worker entrypoints", () => {
    expect(files).toContain("packages/orchestrator/src/index.ts");
  });

  it.each(files)("%s is a Worker entrypoint, not a barrel", (path) => {
    expect(readFileSync(join(REPO_ROOT, path), "utf8")).toMatch(WORKER_DEFAULT_EXPORT);
  });
});
