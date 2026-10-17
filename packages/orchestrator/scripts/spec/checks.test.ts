import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listSpecSetups, readSpecChecks, specDir } from "./checks";

describe("listSpecSetups", () => {
  it("lists a setup file for every setup", () => {
    const setups = listSpecSetups();
    expect(setups.length).toBeGreaterThan(0);
    for (const { spec, setup } of setups) {
      expect(readFileSync(join(specDir(spec), `${setup}.qnt`), "utf8")).toContain(
        `module ${setup} {`,
      );
    }
  });

  it("bounds model checking only for listed setups, always at nightly depth", () => {
    for (const specName of new Set(listSpecSetups().map(({ spec }) => spec))) {
      const checks = readSpecChecks(specName);
      for (const [setup, depths] of Object.entries(checks.tlc?.bounds ?? {})) {
        expect(Object.keys(checks.witnesses)).toContain(setup);
        expect([["nightly"], ["nightly", "pr"]]).toContainEqual(Object.keys(depths).toSorted());
      }
    }
  });
});
