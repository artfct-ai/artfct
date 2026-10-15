import { describe, expect, it } from "bun:test";
import { applyMutant, mutantReport, type Mutant } from "./mutants";

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
