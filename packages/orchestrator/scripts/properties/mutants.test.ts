import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MUTANTS, applyMutant, mutantReport, type Mutant } from "./mutants";
import { standalonePropertyFile } from "./property-files";

const MUTANT: Mutant = {
  id: "X1",
  invariant: "someRule",
  path: "src/example.ts",
  find: "a < b",
  replace: "a <= b",
};

describe("applyMutant", () => {
  it("replaces the one occurrence of its text", () => {
    expect(applyMutant("if (a < b) go();", MUTANT)).toBe("if (a <= b) go();");
  });

  it("refuses source where its text is missing or repeated", () => {
    expect(applyMutant("if (a > b) go();", MUTANT)).toBeNull();
    expect(applyMutant("a < b && a < b", MUTANT)).toBeNull();
  });
});

describe("mutantReport", () => {
  it("lists the mutants that survived or no longer apply", () => {
    const report = mutantReport(
      [
        { mutant: MUTANT, status: "survived" },
        { mutant: { ...MUTANT, id: "X2" }, status: "killed" },
        { mutant: { ...MUTANT, id: "X3" }, status: "not_applied" },
      ],
      5,
    );
    expect(report).toContain("on seed 5");
    expect(report).toContain("| X1 | someRule | `src/example.ts` | survived |");
    expect(report).toContain("| X3 | someRule | `src/example.ts` | no longer applies |");
    expect(report).not.toContain("| X2 |");
  });

  it("is null when every mutant was killed", () => {
    expect(mutantReport([{ mutant: MUTANT, status: "killed" }], 5)).toBeNull();
  });
});

describe("MUTANTS", () => {
  it("each applies to today's source", () => {
    const orchestratorRoot = join(import.meta.dir, "../..");
    const stale = MUTANTS.filter(
      (mutant) =>
        applyMutant(readFileSync(join(orchestratorRoot, mutant.path), "utf8"), mutant) === null,
    ).map((mutant) => mutant.id);
    expect(stale).toEqual([]);
  });

  it("each name a standalone property file when they name one", () => {
    const unknown = MUTANTS.filter(
      (mutant) => mutant.propertyFile && !standalonePropertyFile(mutant.propertyFile),
    ).map((mutant) => mutant.id);
    expect(unknown).toEqual([]);
  });

  it("have unique ids", () => {
    const ids = MUTANTS.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
