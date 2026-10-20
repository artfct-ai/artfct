import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../..");
const CLI_SOURCES = "packages/cli/{src,scripts}/**/*.ts";
const TEST_FILE = /\.test(\.medium)?\.ts$/;
const DEV_VARS_MODULE = "packages/cli/src/dev-vars.ts";
const DEV_VARS_IMPORTERS = [
  "packages/cli/src/check/documents-credential.ts",
  "packages/cli/src/connect/code/github/connect.ts",
];
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
const TEMPLATE_EXPRESSION = /\$\{[^}]*\}/g;
const transpiler = new Bun.Transpiler({ loader: "ts" });

function cliSourceFiles(): string[] {
  return [...new Bun.Glob(CLI_SOURCES).scanSync({ cwd: REPO_ROOT })]
    .filter((path) => !TEST_FILE.test(path))
    .toSorted();
}

function readSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8").replace(/^#!.*\n/, "");
}

function devVarsPathLiterals(source: string): string[] {
  return [...transpiler.transformSync(source).matchAll(STRING_LITERAL)]
    .map(([, , content]) => (content ?? "").replace(TEMPLATE_EXPRESSION, ""))
    .filter((content) => content.includes(".dev.vars") && !/\s/.test(content));
}

function importsDevVarsModule(path: string): boolean {
  return transpiler
    .scanImports(readSource(path))
    .some(
      (imported) =>
        imported.path.startsWith(".") &&
        relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, path)), imported.path)) ===
          DEV_VARS_MODULE.replace(/\.ts$/, ""),
    );
}

describe("the CLI's .dev.vars boundary", () => {
  const files = cliSourceFiles();

  it("finds the dev-vars module and the paths it builds", () => {
    expect(files).toContain(DEV_VARS_MODULE);
    expect(devVarsPathLiterals(readSource(DEV_VARS_MODULE))).not.toEqual([]);
  });

  it("builds a .dev.vars path only in the dev-vars module, so only it reads or writes the file", () => {
    const builders = files.filter(
      (path) => path !== DEV_VARS_MODULE && devVarsPathLiterals(readSource(path)).length > 0,
    );
    expect(builders).toEqual([]);
  });

  it("lets only the GitHub connect flow and the documents credential check import the dev-vars module", () => {
    expect(files.filter(importsDevVarsModule)).toEqual(DEV_VARS_IMPORTERS);
  });
});
