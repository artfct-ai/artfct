import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const REPO_DIR = join(PACKAGE_DIR, "../..");

function typeCheck(files: string[]): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), "artfct-declarations-"));
  const tsconfig = join(root, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [join(PACKAGE_DIR, "worker-configuration.d.ts")],
      },
      files,
    }),
  );
  const result = spawnSync(join(REPO_DIR, "node_modules/.bin/tsc"), ["-p", tsconfig], {
    encoding: "utf8",
  });
  rmSync(root, { recursive: true, force: true });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("the built declarations", () => {
  it("type check the entry files of a deployment repo with a typed config", () => {
    const result = typeCheck([
      join(REPO_DIR, "template/orchestrator/index.ts"),
      join(REPO_DIR, "template/ingress/index.ts"),
      join(PACKAGE_DIR, "test/typed-config-parameter.ts"),
    ]);
    expect(result.output).toBe("");
    expect(result.status).toBe(0);
  });
});
