import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listSpecSetups, readSpecChecks, specDir } from "../spec/checks";
import { MUTANTS } from "./mutants";

type SpecModule = { spec: string; module: string; source: string };

function readSpecModule(spec: string): SpecModule {
  const [setup] = Object.keys(readSpecChecks(spec).witnesses);
  const setupSource = readFileSync(join(specDir(spec), `${setup}.qnt`), "utf8");
  const [, module, file] = /import (\w+)\([\s\S]*?\)\.\* from "\.\/(\w+)"/.exec(setupSource) ?? [];
  if (!module || !file) throw new Error(`${spec}/${setup}.qnt does not instantiate its spec.`);
  return { spec, module, source: readFileSync(join(specDir(spec), `${file}.qnt`), "utf8") };
}

function invariantsEachWitnessIsFor(source: string): Map<string, string[]> {
  const invariantsByWitness = new Map<string, string[]>();
  let doc = "";
  for (const line of source.split("\n")) {
    const docLine = /^\s*\/\/\/ ?(.*)$/.exec(line);
    if (docLine) {
      doc += ` ${docLine[1]}`;
      continue;
    }
    const witness = /^\s*val (\w+)/.exec(line)?.[1];
    const head = /^ Witness for ([^:]*):/.exec(doc)?.[1];
    if (witness && head)
      invariantsByWitness.set(
        witness,
        [...head.matchAll(/`(\w+)`/g)].flatMap(([, invariant]) => invariant ?? []),
      );
    doc = "";
  }
  return invariantsByWitness;
}

const specModules = [...new Set(listSpecSetups().map(({ spec }) => spec))].map(readSpecModule);

const mutatedInvariants = new Set(
  MUTANTS.flatMap(({ invariant }) => invariant.match(/\w+::\w+/g) ?? []),
);

describe.each(specModules)("the $module invariants", ({ spec, module, source }) => {
  const checks = readSpecChecks(spec);

  it("each have a mutant", () => {
    const unmutated = checks.invariants.filter(
      (invariant) => !mutatedInvariants.has(`${module}::${invariant}`),
    );
    expect(unmutated).toEqual([]);
  });

  it("each have a witness that checks.json lists", () => {
    const listed = new Set(Object.values(checks.witnesses).flat());
    const witnessed = new Set(
      [...invariantsEachWitnessIsFor(source)]
        .filter(([witness]) => listed.has(witness))
        .flatMap(([, invariants]) => invariants),
    );
    expect(checks.invariants.filter((invariant) => !witnessed.has(invariant))).toEqual([]);
  });

  it("are the only ones a mutant names in this module", () => {
    const unknown = [...mutatedInvariants].filter(
      (label) =>
        label.startsWith(`${module}::`) &&
        !checks.invariants.includes(label.slice(`${module}::`.length)),
    );
    expect(unknown).toEqual([]);
  });
});
