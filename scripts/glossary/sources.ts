import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceFile } from "./glossary";

/** The repository root. */
const REPO_ROOT = join(import.meta.dirname, "../..");

/** The glossary every check reads. */
const GLOSSARY_PATH = "spec/glossary.md";

const IGNORED =
  /(^|\/)(node_modules|dist|\.wrangler|test)\/|\.(test|replay|property)(\.medium)?\.ts$|\.d\.ts$/;

function filesMatching(patterns: string[]): SourceFile[] {
  return patterns.flatMap((pattern) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT })]
      .filter((path) => !IGNORED.test(path))
      .toSorted()
      .map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") })),
  );
}

/** The code, JSDoc, prompts, and skills that the banned words check reads. */
export function bannedWordSources(): SourceFile[] {
  return filesMatching(["packages/*/src/**/*.ts", "template/**/*.{ts,md,yaml}"]);
}

/** The production code and schema that the code names of the glossary point into. */
export function codeSources(): SourceFile[] {
  return [...bannedWordSources(), ...filesMatching(["packages/*/migrations/**/*.sql"])];
}

/** Where code paths live. Build output and installed packages stay out of the scan. */
const CODE_ROOTS = ["packages/*/src", "packages/*/migrations", "template"];

/** Whether a file under the repository matches a path pattern of a code name. */
export function codePathExists(pattern: string): boolean {
  return CODE_ROOTS.some((root) => {
    for (const path of new Bun.Glob(`${root}/**/${pattern}`).scanSync({ cwd: REPO_ROOT })) {
      if (!IGNORED.test(path)) return true;
    }
    return false;
  });
}

/** The glossary text. */
export function readGlossary(): string {
  return readFileSync(join(REPO_ROOT, GLOSSARY_PATH), "utf8");
}
